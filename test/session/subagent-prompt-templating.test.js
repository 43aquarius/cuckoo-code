'use strict';
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

// Electron 为外部运行时边界（其 index.js 导出可执行文件路径字符串，非模块）。
// 用 Module._load 拦截 require('electron')，把 app 指到真实项目根，
// 使 paths/prompt-builder 使用真实模板与文件。仅模拟外部边界，不 mock 内部模块。
const origLoad = Module._load;
Module._load = function (request, _parent, _isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => path.join(process.cwd(), 'test', 'tmp', 'subagent-prompt-userdata'),
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

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-subagent-'));
}

// —— 模板文件契约（占位符集合） ——

test('subagent-default.md 仅声明 6 个子代理占位符，不含主 Agent 专属占位符', () => {
  const mdPath = path.join(pb.PROMPT_DIR, 'subagent-default.md');
  assert.ok(fs.existsSync(mdPath), 'subagent-default.md 应存在');
  const content = fs.readFileSync(mdPath, 'utf-8');
  for (const ph of ['{{PLATFORM_INFO}}', '{{TOOL_API_TYPES}}', '{{TOOL_SECTIONS}}', '{{MCP_SECTION}}', '{{TOOLS_LIST}}', '{{PROJECT_DIR}}']) {
    assert.ok(content.includes(ph), '子模板应含占位符 ' + ph);
  }
  for (const ph of ['{{SKILLS_SECTION}}', '{{AGENTS_SECTION}}', '{{PROJECT_INTRO_SECTION}}', '{{PROJECT_RULES_SECTION}}', '{{WORKFLOW_RULES_SECTION}}']) {
    assert.ok(!content.includes(ph), '子模板不应含主 Agent 占位符 ' + ph);
  }
});

test('主模板 default.md/deepseek.md 仍声明 5 个主 Agent 专属占位符（回归）', () => {
  for (const f of ['default.md', 'deepseek.md']) {
    const content = fs.readFileSync(path.join(pb.PROMPT_DIR, f), 'utf-8');
    for (const ph of ['{{SKILLS_SECTION}}', '{{AGENTS_SECTION}}', '{{PROJECT_INTRO_SECTION}}', '{{PROJECT_RULES_SECTION}}', '{{WORKFLOW_RULES_SECTION}}']) {
      assert.ok(content.includes(ph), f + ' 应含主 Agent 占位符 ' + ph);
    }
  }
});

// —— buildPrompt(isSubagent) 输出契约 ——

test('buildPrompt(isSubagent=true)：不含主 Agent 章节标记与占位符残留，含 MCP 能力', () => {
  const tmp = tmpProject();
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isSubagent: true });
    assert.ok(!r.error, r.error);
    const p = r.prompt;
    assert.ok(!p.includes('## 可用技能（Skills）'), '子代理不应含技能章节');
    assert.ok(!p.includes('## 可用子代理（Agents）'), '子代理不应含子代理章节');
    assert.ok(!p.includes('## 项目规则'), '子代理不应含项目规则章节');
    assert.ok(!p.includes('## 项目介绍'), '子代理不应含项目介绍章节');
    assert.ok(!p.includes('## 工作流规则（强制）'), '子代理不应含工作流规则章节');
    assert.ok(p.includes('## MCP 能力'), '子代理 prompt 应含 MCP 章节');
    assert.ok(!p.includes('{{'), '子代理 prompt 不应残留 {{ 占位符');
    assert.ok(p.includes(tmp), '子代理 prompt 应含项目目录');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt(isSubagent=false)：仍含全部主 Agent 章节（回归）', () => {
  const tmp = tmpProject();
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(!r.error, r.error);
    const p = r.prompt;
    assert.ok(p.includes('## MCP 能力'), '主 Agent prompt 应含 MCP 章节');
    assert.ok(p.includes('## 工作流规则（强制）'), '主 Agent prompt 应含工作流规则章节');
    assert.ok(!p.includes('{{'), '主 Agent prompt 不应残留 {{ 占位符');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt(isSubagent=true)：即使 CUCKOO.md 存在也不注入项目介绍（模板无占位符）', () => {
  const tmp = tmpProject();
  try {
    const dir = path.join(tmp, '.cuckooCode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CUCKOO.md'), '主编协议污染内容XYZ', 'utf-8');
    const sub = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isSubagent: true });
    assert.ok(!sub.prompt.includes('主编协议污染内容XYZ'), '子代理不应注入 CUCKOO.md 内容');
    assert.ok(!sub.prompt.includes('## 项目介绍'), '子代理不应含项目介绍章节');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt(isSubagent=true)：过滤 runAgent 工具（防递归，回归）', () => {
  const tmp = tmpProject();
  try {
    const normal = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    const sub = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isSubagent: true });
    const listEntry = '\u0060runAgent(name, task)\u0060 — ';
    const sectionText = '使用 runAgent(name, task) 把任务委派给子代理';
    assert.ok(normal.prompt.includes(listEntry), '主窗口应含 runAgent 工具清单条目');
    assert.ok(!sub.prompt.includes(listEntry), '子代理不应含 runAgent 工具清单条目');
    assert.ok(!sub.prompt.includes(sectionText), '子代理不应含 runAgent section');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadTemplate(isSubagent=true) 回退 subagent-default.md，false 走主模板', () => {
  const sub = pb.loadTemplate('deepseek', true);
  assert.ok(!sub.error, sub.error);
  assert.ok(sub.path.endsWith('subagent-default.md'), sub.path);
  const main = pb.loadTemplate('deepseek', false);
  assert.ok(main.path.endsWith('deepseek.md'), main.path);
});
