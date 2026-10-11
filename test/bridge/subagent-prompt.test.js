'use strict';
/**
 * T2c 子代理首条消息段构建测试
 *
 * 被测：src/bridge/subagent-prompt.ts
 *   - buildRoleSection(agentTemplate)：角色段 + 身份声明；空模板返回空串
 *   - buildProtocolSection(task)：协议段（子代理模式/回复模式/交付方式/禁止/行为规则/任务）
 *
 * 权威源：cuckoo-code-master051/src/main/subagent-runner.js L359-481
 */
import { test, describe } from 'vitest';
import assert from 'node:assert';
import {
  buildRoleSection,
  buildProtocolSection,
} from '../../src/bridge/subagent-prompt.js';

describe('buildRoleSection（角色段）', () => {
  test('含【你的角色】与【身份声明】，模板正文被包裹', () => {
    const out = buildRoleSection('你是测试工程师');
    assert.match(out, /【你的角色】/);
    assert.ok(out.includes('你是测试工程师'));
    assert.match(out, /【身份声明】/);
    assert.ok(out.includes('而非通用编程助手'));
  });

  test('模板首尾空白被 trim', () => {
    const out = buildRoleSection('   \n  内容  \n  ');
    assert.ok(out.includes('内容'));
  });

  test('空/null/undefined 模板 -> 返回空串', () => {
    assert.strictEqual(buildRoleSection(''), '');
    assert.strictEqual(buildRoleSection('   '), '');
    assert.strictEqual(buildRoleSection(null), '');
    assert.strictEqual(buildRoleSection(undefined), '');
  });
});

describe('buildProtocolSection（协议段）', () => {
  test('首行含 ## 你的任务（m-3 对齐 051 L478）', () => {
    const out = buildProtocolSection('做某事');
    assert.strictEqual(out.split('\n')[0], '## 你的任务');
  });

  test('包含全部协议小节标题', () => {
    const out = buildProtocolSection('做某事');
    for (const h of ['【子 Agent 模式】', '【回复模式】', '【交付方式（重要，必读）】', '【禁止】', '【行为规则】', '【任务】']) {
      assert.ok(out.includes(h), '协议段应含 ' + h);
    }
  });

  test('回复模式三种（模式 A/B/C）均存在', () => {
    const out = buildProtocolSection('做某事');
    assert.match(out, /模式 A - 工具调用/);
    assert.match(out, /模式 B - 最终交付/);
    assert.match(out, /模式 C - 错误交付/);
    assert.match(out, /subagent_result/);
  });

  test('子代理模式声明不含向用户提问指引', () => {
    const out = buildProtocolSection('做某事');
    assert.match(out, /你没有用户可问/);
  });

  test('task 文本出现在末尾【任务】章节', () => {
    const task = '请分析 E:/proj-x 的日志';
    const out = buildProtocolSection(task);
    assert.ok(out.includes('【任务】'));
    assert.ok(out.trimEnd().endsWith(task), '任务文本应在段末');
  });

  test('空 task 不抛错，仍产出完整协议段', () => {
    const out = buildProtocolSection('');
    assert.match(out, /## 你的任务/);
    assert.ok(out.includes('【任务】'));
  });
});
