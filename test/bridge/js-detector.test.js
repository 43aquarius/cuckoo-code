'use strict';
import { test } from 'vitest';
import assert from 'node:assert';
import {
  BT,
  FENCE,
  looksLikeIncompleteCodeError,
  looksLikeToolScript,
  hasOnlyFences,
  extractJsToolBlocks,
  extractSubagentResultBlocks,
  countAwaitCalls,
} from '../../src/bridge/parser/js-detector.js';

test('BT 和 FENCE 定义', () => {
  assert.strictEqual(BT, '`');
  assert.strictEqual(FENCE, '```');
});

test('looksLikeToolScript 识别 await 工具调用', () => {
  assert.strictEqual(looksLikeToolScript('await bash("echo hi")'), true);
  assert.strictEqual(looksLikeToolScript('const x = await read("a.txt")'), true);
  assert.strictEqual(looksLikeToolScript('await write("a", "b")'), true);
});

test('looksLikeToolScript 拒绝普通代码', () => {
  assert.strictEqual(looksLikeToolScript('fs.readFile("a.txt")'), false);
  assert.strictEqual(looksLikeToolScript('console.log(1)'), false);
  assert.strictEqual(looksLikeToolScript(''), false);
  assert.strictEqual(looksLikeToolScript(null), false);
});

test('looksLikeIncompleteCodeError 匹配语法错误', () => {
  assert.strictEqual(looksLikeIncompleteCodeError('SyntaxError: Unexpected end'), true);
  assert.strictEqual(looksLikeIncompleteCodeError('Unexpected token'), true);
  assert.strictEqual(looksLikeIncompleteCodeError('normal error'), false);
  assert.strictEqual(looksLikeIncompleteCodeError(null), false);
});

test('hasOnlyFences 仅代码块', () => {
  assert.strictEqual(hasOnlyFences('```js\ncode\n```'), true);
  assert.strictEqual(hasOnlyFences('```js\ncode\n```\n\n```js\nmore\n```'), true);
  assert.strictEqual(hasOnlyFences('text ```js\ncode\n```'), false);
  assert.strictEqual(hasOnlyFences('no fence'), false);
  assert.strictEqual(hasOnlyFences(null), false);
});

test('extractJsToolBlocks 提取 cuckoo 块', () => {
  const text = '```cuckoo\nawait read("a.txt")\n```';
  const blocks = extractJsToolBlocks(text);
  assert.deepStrictEqual(blocks, ['await read("a.txt")']);
});

test('extractJsToolBlocks js 块仅当只有代码块', () => {
  const js = '```js\nawait bash("echo")\n```';
  assert.deepStrictEqual(extractJsToolBlocks(js), ['await bash("echo")']);
  const mixed = '说明\n```js\nawait bash("echo")\n```';
  assert.deepStrictEqual(extractJsToolBlocks(mixed), []);
});

test('extractJsToolBlocks 忽略普通 js', () => {
  const js = '```js\nconsole.log(1)\n```';
  assert.deepStrictEqual(extractJsToolBlocks(js), []);
});

test('extractJsToolBlocks 空输入', () => {
  assert.deepStrictEqual(extractJsToolBlocks(''), []);
  assert.deepStrictEqual(extractJsToolBlocks(null), []);
});

// ========== T2a countAwaitCalls（子代理「单块调用数门禁」的计数工具）==========
// 正则通配任意 "await 标识符("，非白名单；>100 保护性截断

test('countAwaitCalls：无 await 调用返回 0', () => {
  assert.strictEqual(countAwaitCalls('const a = 1;'), 0);
});

test('countAwaitCalls：恰好 3 个 await 调用返回 3', () => {
  const code = [
    'const a = await read("a.txt");',
    'const b = await grep("TODO", a);',
    'log(await bash("echo hi"));',
  ].join(String.fromCharCode(10));
  assert.strictEqual(countAwaitCalls(code), 3);
});

test('countAwaitCalls：4 个 await 调用返回 4（超单块上限）', () => {
  const code = [1, 2, 3, 4].map((i) => 'await read("f' + i + '.txt");').join(String.fromCharCode(10));
  assert.strictEqual(countAwaitCalls(code), 4);
});

test('countAwaitCalls：空串 / null / undefined 与非 await 调用均计 0', () => {
  assert.strictEqual(countAwaitCalls(''), 0);
  assert.strictEqual(countAwaitCalls(null), 0);
  assert.strictEqual(countAwaitCalls(undefined), 0);
  assert.strictEqual(countAwaitCalls('foo(1)'), 0);
});

test('countAwaitCalls：await 与函数名/括号间含空格仍计数', () => {
  assert.strictEqual(countAwaitCalls('await  read ("a")'), 1);
});

test('countAwaitCalls：极端大量调用保护性截断返回 101', () => {
  const code = Array.from({ length: 150 }, () => 'await read("x");').join(String.fromCharCode(10));
  assert.strictEqual(countAwaitCalls(code), 101);
});

// ========== T2c extractSubagentResultBlocks（子代理最终交付物提取）==========
// 仅收录 lang === 'subagent_result' 的围栏块（大小写不敏感）；不执行，直接作为结果

test('extractSubagentResultBlocks：单个 subagent_result 块', () => {
  const text = '说明文字\n\n' + FENCE + 'subagent_result\n最终交付物\n' + FENCE;
  assert.deepStrictEqual(extractSubagentResultBlocks(text), ['最终交付物']);
});

test('extractSubagentResultBlocks：多个块按出现顺序返回', () => {
  const text = [FENCE + 'subagent_result\nA\n' + FENCE, '间隔', FENCE + 'subagent_result\nB\n' + FENCE].join('\n\n');
  assert.deepStrictEqual(extractSubagentResultBlocks(text), ['A', 'B']);
});

test('extractSubagentResultBlocks：非 subagent_result 语言不收录', () => {
  const text = FENCE + 'js\nawait read("a")\n' + FENCE;
  assert.deepStrictEqual(extractSubagentResultBlocks(text), []);
  const cuckoo = FENCE + 'cuckoo\nawait read("a")\n' + FENCE;
  assert.deepStrictEqual(extractSubagentResultBlocks(cuckoo), []);
});

test('extractSubagentResultBlocks：无围栏 -> 空数组', () => {
  assert.deepStrictEqual(extractSubagentResultBlocks('就是一段纯文本'), []);
});

test('extractSubagentResultBlocks：空/null/undefined/非字符串 -> 空数组', () => {
  assert.deepStrictEqual(extractSubagentResultBlocks(''), []);
  assert.deepStrictEqual(extractSubagentResultBlocks(null), []);
  assert.deepStrictEqual(extractSubagentResultBlocks(undefined), []);
  assert.deepStrictEqual(extractSubagentResultBlocks(123), []);
});

test('extractSubagentResultBlocks：CRLF 行尾被规整', () => {
  const text = FENCE + 'subagent_result\r\nline1\r\nline2\r\n' + FENCE;
  assert.deepStrictEqual(extractSubagentResultBlocks(text), ['line1\nline2']);
});

test('extractSubagentResultBlocks：未闭合围栏（末尾 flush）仍收录', () => {
  const text = '说明\n' + FENCE + 'subagent_result\n未闭合内容';
  assert.deepStrictEqual(extractSubagentResultBlocks(text), ['未闭合内容']);
});

test('extractSubagentResultBlocks：lang 含空格取首词；大小写不敏感', () => {
  const text = FENCE + 'Subagent_Result extra\n内容\n' + FENCE;
  assert.deepStrictEqual(extractSubagentResultBlocks(text), ['内容']);
});

test('extractSubagentResultBlocks：空白块内容被跳过', () => {
  const text = FENCE + 'subagent_result\n   \n' + FENCE;
  assert.deepStrictEqual(extractSubagentResultBlocks(text), []);
});

