'use strict';
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

// Electron 是"外部运行时边界"（其 index.js 导出的是可执行文件路径字符串，非模块）。
// 真实 Electron 下 app.getAppPath() 返回项目根；这里用 Module._load 拦截 require('electron')，
// 把 app 指到真实项目根，从而让 paths/prompt-builder 用真实模板与文件跑起来。
// 这不属于"mock 内部模块"，符合测试哲学（只模拟外部边界）。
const origLoad = Module._load;
Module._load = function (request, _parent, _isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => path.join(process.cwd(), 'test', 'tmp', 'prompt-builder-userdata'),
        isPackaged: false,
      },
    };
  }
  return origLoad.apply(this, arguments);
};

let pb;
beforeAll(async () => {
  pb = await import('../../src/session/prompt-builder.js');
});

afterAll(() => {
  Module._load = origLoad;
});

test('PROMPT_DIR 指向 src/prompt', () => {
  assert.ok(pb.PROMPT_DIR.endsWith(path.join('src', 'prompt')), pb.PROMPT_DIR);
});

test('loadTemplate 已知平台返回非空内容', () => {
  const r = pb.loadTemplate('deepseek');
  assert.ok(r.content.length > 0);
  assert.ok(!r.error);
});

test('loadTemplate 未知 providerId 回退 default.md', () => {
  const r = pb.loadTemplate('no-such-provider-xyz');
  assert.ok(r.content.length > 0, '应回退到 default.md');
  assert.ok(r.path.endsWith('default.md'));
  assert.ok(!r.error);
});

test('loadTemplate provider.getPromptTemplate 优先级最高', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => '来自 getPromptTemplate 的模板内容 {{TOOLS_LIST}}';
  try {
    const r = pb.loadTemplate('deepseek');
    assert.strictEqual(r.path, '(provider.getPromptTemplate)');
    assert.ok(r.content.includes('来自 getPromptTemplate'));
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('loadTemplate provider.getPromptTemplate 返回空则回退文件模板', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => '   ';
  try {
    const r = pb.loadTemplate('deepseek');
    assert.ok(r.path.endsWith('deepseek.md'));
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('loadTemplate provider.getPromptTemplate 抛错时回退文件模板', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => { throw new Error('模板方法崩溃'); };
  try {
    const r = pb.loadTemplate('deepseek');
    assert.ok(r.content.length > 0);
    assert.ok(!r.error);
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('buildPrompt 替换核心占位符', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(!r.error, r.error);
    const p = r.prompt;
    // 占位符应已被替换（不再残留）
    assert.ok(!p.includes('{{TOOLS_LIST}}'));
    assert.ok(!p.includes('{{TOOL_SECTIONS}}'));
    assert.ok(!p.includes('{{PLATFORM_INFO}}'));
    assert.ok(!p.includes('{{PROJECT_DIR}}'));
    assert.ok(!p.includes('{{MCP_SECTION}}'));
    assert.ok(!p.includes('{{TOOL_API_TYPES}}'));
    assert.ok(!p.includes('{{PROJECT_INTRO_SECTION}}'));
    // 项目目录被写入
    assert.ok(p.includes(tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt PLATFORM_INFO 含当前平台信息', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(r.prompt.includes('操作系统'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt isCompaction 末尾追加"请继续你之前的工作"', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isCompaction: true });
    assert.ok(r.prompt.includes('请继续你之前的工作'));
    assert.ok(r.prompt.trimEnd().endsWith('请继续你之前的工作'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 无 CUCKOO.md 时 PROJECT_INTRO_SECTION 为空', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    // 没有项目介绍章节
    assert.ok(!r.prompt.includes('## 项目介绍'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 读取 CUCKOO.md 并注入项目介绍', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const dir = path.join(tmp, '.cuckooCode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CUCKOO.md'), '这是一个测试项目的介绍内容', 'utf-8');
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(r.prompt.includes('## 项目介绍'));
    assert.ok(r.prompt.includes('这是一个测试项目的介绍内容'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 不存在的模板文件走 default（未知 provider）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'nonexistent-xyz', selectedDir: tmp });
    assert.ok(!r.error);
    assert.ok(r.prompt.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt isSubagent=true：过滤 runAgent 工具清单与 section（M-2）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const normal = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    const sub = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isSubagent: true });
    // 工具清单条目（getFormattedJsApiForPrompt）：`runAgent(name, task)` — ...
    const listEntry = '\u0060runAgent(name, task)\u0060 — ';
    // 工具 section（getPromptSection）：使用 runAgent(name, task) 把任务委派给子代理。
    const sectionText = '使用 runAgent(name, task) 把任务委派给子代理';
    // 主窗口默认仍含 runAgent（回归保护，主窗口行为不变）
    assert.ok(normal.prompt.includes(listEntry), '主窗口 prompt 应含 runAgent 工具清单条目');
    assert.ok(normal.prompt.includes(sectionText), '主窗口 prompt 应含 runAgent section');
    // 子代理 prompt 过滤掉 runAgent 的工具清单与 section
    assert.ok(!sub.prompt.includes(listEntry), '子代理 prompt 不应含 runAgent 工具清单条目');
    assert.ok(!sub.prompt.includes(sectionText), '子代理 prompt 不应含 runAgent section');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt isSubagent=true：MCP 章节全给（模板驱动，用户裁定）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const normal = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    const sub = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isSubagent: true });
    assert.ok(normal.prompt.includes('## MCP 能力'), '主窗口 prompt 应含 MCP 章节');
    assert.ok(sub.prompt.includes('## MCP 能力'), '子代理 prompt 也应含 MCP 章节（用户裁定 MCP 全给）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt isSubagent=true：不注入 CUCKOO.md（回归保护）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const dir = path.join(tmp, '.cuckooCode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CUCKOO.md'), '主编协议污染内容XYZ', 'utf-8');
    const sub = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isSubagent: true });
    assert.ok(!sub.prompt.includes('主编协议污染内容XYZ'), '子代理不应注入 CUCKOO.md');
    assert.ok(!sub.prompt.includes('## 项目介绍'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadTemplate isSubagent=true 回退 subagent-default.md（M-1）', () => {
  const r = pb.loadTemplate('deepseek', true);
  assert.ok(!r.error, r.error);
  assert.ok(r.content.length > 0, '子代理模板内容不应为空');
  assert.ok(r.path.endsWith('subagent-default.md'), r.path);
});

test('loadTemplate isSubagent=true 未知 providerId 也回退 subagent-default.md', () => {
  const r = pb.loadTemplate('no-such-provider-xyz', true);
  assert.ok(!r.error, r.error);
  assert.ok(r.content.length > 0);
  assert.ok(r.path.endsWith('subagent-default.md'), r.path);
});

test('loadTemplate isSubagent=false 保持主模板（M-1）', () => {
  const known = pb.loadTemplate('deepseek', false);
  assert.ok(known.path.endsWith('deepseek.md'), known.path);
  const unknown = pb.loadTemplate('no-such-provider-xyz', false);
  assert.ok(unknown.path.endsWith('default.md'), unknown.path);
});

test('subagent-default.md 内容约束：无人机对话表述（M-1）', () => {
  const mdPath = path.join(pb.PROMPT_DIR, 'subagent-default.md');
  assert.ok(fs.existsSync(mdPath), 'subagent-default.md 应存在');
  const content = fs.readFileSync(mdPath, 'utf-8');
  assert.ok(!content.includes('主动向用户提问'), '不应含「主动向用户提问」');
  assert.ok(!content.includes('先给计划'), '不应含「先给计划」');
  assert.ok(content.includes('无人值守'), '应含「无人值守」');
});

test('buildPrompt 主窗口注入工作流规则（WORKFLOW_RULES_SECTION）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(!r.error, r.error);
    assert.ok(r.prompt.includes('## 工作流规则（强制）'), '主窗口 prompt 应含工作流规则章节');
    assert.ok(!r.prompt.includes('{{WORKFLOW_RULES_SECTION}}'), '占位符应已被替换');
    // 不绑定具体文案：规则文件是用户可编辑的模板，标题可自定义。
    // 只断言「文件内容确实被注入」（取文件首行标题作为指纹）。
    const wfPath = path.join(process.cwd(), 'src', 'prompt', 'workflow-rules.md');
    const firstHeading = fs.readFileSync(wfPath, 'utf-8')
      .split(/\r?\n/).find((l) => l.startsWith('# '));
    assert.ok(firstHeading, '规则文件应有 Markdown 标题');
    assert.ok(r.prompt.includes(firstHeading.trim()), '应含规则文件内容（标题指纹）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt isSubagent=true：不注入工作流规则（即使模板含占位符）', async () => {
  // 有效性关键：必须走「含 {{WORKFLOW_RULES_SECTION}} 占位符」的模板。
  // 子代理默认用 subagent-default.md（无占位符），那样断言无法捕获 isSubagent 抑制回归。
  // 这里用 provider.getPromptTemplate 强制返回含占位符的模板，使占位符真实参与替换：
  // 若 prompt-builder.ts L202 的 isSubagent 抑制被移除，readWorkflowRules() 会执行，
  // 占位符被替换为规则内容 → 下列「子代理不含规则」断言必然变红（区分力判据）。
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => 'TEMPLATE {{WORKFLOW_RULES_SECTION}} END';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const normal = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    const sub = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isSubagent: true });
    assert.ok(sub.prompt.includes('TEMPLATE'), '子代理应使用含占位符的模板');
    assert.ok(normal.prompt.includes('## 工作流规则（强制）'), '主窗口 prompt 应含工作流规则章节');
    assert.ok(!normal.prompt.includes('{{WORKFLOW_RULES_SECTION}}'), '主窗口占位符应已被替换');
    assert.ok(sub.prompt.includes('## 工作流规则（强制）'), '子代理 prompt 也应含工作流规则章节（模板驱动：占位符由 provider 模板声明）');
    assert.ok(!sub.prompt.includes('{{WORKFLOW_RULES_SECTION}}'), '子代理占位符应已被替换为空');
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

