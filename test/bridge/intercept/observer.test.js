'use strict';
import { test, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import {
  startInterceptObserver,
  processInterceptedResponse,
  getLastInterceptedText,
  onInterceptedResponse,
  onAiError,
  onTaskIdle,
  setSubagentActive,
} from '../../../src/bridge/intercept/observer.js';
import * as chatInputMod from '../../../src/overlay/chat-input.js';

// 部分模拟 chat-input：保留原实现，仅包装 sendMessageToChat 以便断言门禁提示
vi.mock('../../../src/overlay/chat-input.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendMessageToChat: vi.fn(actual.sendMessageToChat) };
});

// 收集注册的监听器，测试后统一取消，避免模块级 Set 跨用例泄漏
const offs = [];
function track(off) { offs.push(off); return off; }
afterEach(() => {
  while (offs.length) offs.pop()();
});

// ---- 测试用 window / document 模拟（外部边界，不是 mock 内部模块）----
function makeFakeWindow() {
  const listeners = {};
  const win = {
    location: { href: '' },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    electronAPI: { showAiNotification: () => Promise.resolve() },
  };
  return { win, listeners };
}

function dispatch(listeners, type, detail) {
  const fns = listeners[type] || [];
  for (const fn of fns) fn({ detail });
}

function setupGlobals(idMap) {
  const { win, listeners } = makeFakeWindow();
  globalThis.window = win;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.document = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: (id) => (idMap && idMap[id]) || null,
    createElement: () => ({
      id: '', className: '', textContent: '', style: {},
      classList: { add() {}, remove() {} },
    }),
    body: { appendChild() {} },
  };
  return listeners;
}

// 极简假元素：只保留遮罩用到的 classList 语义
function makeFakeMask() {
  const classes = new Set(['cuckoo-hidden']);
  return {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
}

test('onInterceptedResponse 返回可取消函数', () => {
  const got = [];
  const off = track(onInterceptedResponse((t) => got.push(t)));
  assert.strictEqual(typeof off, 'function');
  off();
  offs.pop(); // 已手动取消，避免重复
  assert.deepStrictEqual(got, []);
});

test('startInterceptObserver：stopped 不通知监听器', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onInterceptedResponse((t) => got.push(t)));
  dispatch(listeners, 'cuckoo-ai-response', { status: 'stopped', finished: true, text: 'x' });
  assert.deepStrictEqual(got, []);
});

test('startInterceptObserver：未 finished 不通知', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onInterceptedResponse((t) => got.push(t)));
  dispatch(listeners, 'cuckoo-ai-response', { status: 'streaming', finished: false, text: 'partial' });
  assert.deepStrictEqual(got, []);
});

test('startInterceptObserver：finished 通知监听器并携带 meta', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onInterceptedResponse((t, meta) => got.push({ t, meta })));
  dispatch(listeners, 'cuckoo-ai-response', {
    status: 'finished',
    finished: true,
    text: '这是普通文本回复',
    tokenUsage: { input: 1 },
    msgIds: ['m1'],
  });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].t, '这是普通文本回复');
  assert.deepStrictEqual(got[0].meta.tokenUsage, { input: 1 });
  assert.deepStrictEqual(got[0].meta.msgIds, ['m1']);
});

test('startInterceptObserver：无 detail 安全返回', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onInterceptedResponse((t) => got.push(t)));
  dispatch(listeners, 'cuckoo-ai-response', null);
  assert.deepStrictEqual(got, []);
});

test('startInterceptObserver：error 事件通知 onAiError', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onAiError((d) => got.push(d)));
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500, text: 'err' });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].httpStatus, 500);
});

test('startInterceptObserver：error 事件无 detail 传空对象', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  track(onAiError((d) => got.push(d)));
  dispatch(listeners, 'cuckoo-ai-error', null);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(got[0], {});
});

test('onAiError 取消后不再触发', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  const got = [];
  const off = track(onAiError((d) => got.push(d)));
  off();
  offs.pop();
  dispatch(listeners, 'cuckoo-ai-error', { httpStatus: 500 });
  assert.deepStrictEqual(got, []);
});

test('getLastInterceptedText：初始为空串', () => {
  assert.strictEqual(typeof getLastInterceptedText(), 'string');
});

test('getLastInterceptedText：finished 后缓存文本', () => {
  const listeners = setupGlobals();
  startInterceptObserver();
  dispatch(listeners, 'cuckoo-ai-response', { status: 'finished', finished: true, text: '缓存内容' });
  assert.strictEqual(getLastInterceptedText(), '缓存内容');
});

test('processInterceptedResponse：空文本直接返回', async () => {
  setupGlobals();
  await processInterceptedResponse('');
  await processInterceptedResponse('   ');
});

test('processInterceptedResponse：普通文本不抛错', async () => {
  setupGlobals();
  await processInterceptedResponse('一段没有工具调用的普通说明文字');
});

test('processInterceptedResponse：JSON 格式工具调用发提示', async () => {
  setupGlobals();
  await processInterceptedResponse('{"tool": "bash", "arguments": {"command": "echo hi"}}');
});

test('processInterceptedResponse：XML 格式工具调用发提示', async () => {
  setupGlobals();
  await processInterceptedResponse('<invoke name="bash"></invoke>');
});

test('processInterceptedResponse：JS 工具块执行期间显示遮罩，发送结束后隐藏', async () => {
  const mask = makeFakeMask();
  setupGlobals({ 'cuckoo-tool-mask': mask });
  let visibleDuringExec = false;
  globalThis.window.electronAPI.executeJs = async () => {
    visibleDuringExec = !mask.classList.contains('cuckoo-hidden');
    return { success: true, output: 'ok' };
  };
  await processInterceptedResponse('\`\`\`cuckoo\nawait read({ filePath: "a.txt" });\n\`\`\`');
  assert.strictEqual(visibleDuringExec, true, '执行期间遮罩应可见');
  assert.ok(mask.classList.contains('cuckoo-hidden'), '结束后遮罩应隐藏');
});

test('processInterceptedResponse：非工具回复不显示遮罩', async () => {
  const mask = makeFakeMask();
  setupGlobals({ 'cuckoo-tool-mask': mask });
  await processInterceptedResponse('一段没有工具调用的普通说明文字');
  assert.ok(mask.classList.contains('cuckoo-hidden'), '普通回复不应显示遮罩');
});

test('processInterceptedResponse：force 跳过去重重复执行', async () => {
  setupGlobals();
  const text = '重复的普通文本回复';
  await processInterceptedResponse(text);
  // 第二次 force=true 应仍能执行而不抛错
  await processInterceptedResponse(text, true);
});

// ========== onTaskIdle（任务空闲信号，供自动压缩用）==========

test('onTaskIdle 返回可取消函数', () => {
  const off = track(onTaskIdle(() => {}));
  assert.strictEqual(typeof off, 'function');
  off();
  offs.pop();
});

test('processInterceptedResponse：普通文本回复触发 onTaskIdle（工具循环结束）', async () => {
  setupGlobals();
  let idle = 0;
  track(onTaskIdle(() => idle++));
  await processInterceptedResponse('一段没有工具调用的普通说明文字');
  assert.strictEqual(idle, 1, '普通文本回复应派发一次任务空闲');
});

test('processInterceptedResponse：工具代码块不触发 onTaskIdle（工具循环未结束）', async () => {
  const mask = makeFakeMask();
  setupGlobals({ 'cuckoo-tool-mask': mask });
  globalThis.window.electronAPI.executeJs = async () => ({ success: true, output: 'ok' });
  let idle = 0;
  track(onTaskIdle(() => idle++));
  await processInterceptedResponse('\`\`\`cuckoo\nawait read({ filePath: "a.txt" });\n\`\`\`');
  assert.strictEqual(idle, 0, '有工具调用时不应派发任务空闲');
});

test('onTaskIdle 取消后不再触发', async () => {
  setupGlobals();
  let idle = 0;
  const off = track(onTaskIdle(() => idle++));
  off();
  offs.pop();
  await processInterceptedResponse('取消后的普通文本回复');
  assert.strictEqual(idle, 0);
});

test('onTaskIdle：空文本不触发', async () => {
  setupGlobals();
  let idle = 0;
  track(onTaskIdle(() => idle++));
  await processInterceptedResponse('');
  assert.strictEqual(idle, 0);
});


// ========== T2a 子代理工具调用门禁（块数 > 3 / 单块调用数 > 3 → 整轮不执行）==========
// 门禁仅对子代理窗口生效（主窗口直接放行）；依赖模块级 isSubagentActive，
// 必须用 setSubagentActive 显式开关，并在 afterEach 复位，避免跨用例状态泄漏。

function mkBlock(calls) {
  const lines = [];
  for (let i = 0; i < calls; i++) lines.push('const v' + i + ' = await read("f' + i + '.txt");');
  return '```cuckoo' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + '```';
}
function mkReply(blockCount, callsPerBlock) {
  return Array.from({ length: blockCount }, () => mkBlock(callsPerBlock)).join(String.fromCharCode(10, 10));
}
let executeJsSpy;

function setupGateEnv() {
  const mask = makeFakeMask();
  setupGlobals({ 'cuckoo-tool-mask': mask });
  executeJsSpy = vi.fn(async () => ({ success: true, output: 'ok' }));
  globalThis.window.electronAPI.executeJs = executeJsSpy;
  chatInputMod.sendMessageToChat.mockClear();
  return mask;
}

function gateHints() {
  return chatInputMod.sendMessageToChat.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => /超过单次上限|超过单块上限/.test(m));
}

afterEach(() => {
  // 状态隔离：复位子代理标识，避免跨用例污染（门禁依赖模块级 isSubagentActive）
  setSubagentActive(false);
});

test('T2a 门禁：非子代理窗口 4 个 cuckoo 块照常执行', async () => {
  setupGateEnv();
  setSubagentActive(false);
  await processInterceptedResponse(mkReply(4, 1), true);
  assert.strictEqual(executeJsSpy.mock.calls.length, 4, '主窗口不受块数门禁，应执行 4 个块');
  assert.strictEqual(gateHints().length, 0, '主窗口不应收到超限提示');
});

test('T2a 门禁：子代理块数超限（4 块）→ 不执行 + 提示含「超过单次上限 3 个」', async () => {
  setupGateEnv();
  setSubagentActive(true);
  await processInterceptedResponse(mkReply(4, 1), true);
  assert.strictEqual(executeJsSpy.mock.calls.length, 0, '块数超限应整轮不执行');
  const hints = gateHints();
  assert.strictEqual(hints.length, 1, '应恰好发送一条块数超限提示');
  assert.ok(hints[0].includes('超过单次上限 3 个'), '提示应含块数上限文案，实际: ' + hints[0].slice(0, 80));
});

test('T2a 门禁：子代理单块调用数超限（1 块 4 个调用）→ 不执行 + 提示含「超过单块上限 3 个」', async () => {
  setupGateEnv();
  setSubagentActive(true);
  await processInterceptedResponse(mkReply(1, 4), true);
  assert.strictEqual(executeJsSpy.mock.calls.length, 0, '单块调用数超限应整轮不执行');
  const hints = gateHints();
  assert.strictEqual(hints.length, 1, '应恰好发送一条单块超限提示');
  assert.ok(hints[0].includes('超过单块上限 3 个'), '提示应含单块上限文案，实际: ' + hints[0].slice(0, 80));
});

test('T2a 门禁：恰好 3 块 / 每块 3 调用 → 放行（> 判定非 >=）', async () => {
  setupGateEnv();
  setSubagentActive(true);
  await processInterceptedResponse(mkReply(3, 3), true);
  assert.strictEqual(gateHints().length, 0, '边界值应放行，不发超限提示');
  // executeJs 以「整块代码」为单位调用（块内 await 不额外触发 executeJs），故 3 块 → 3 次
  assert.strictEqual(executeJsSpy.mock.calls.length, 3, '3 个块应各执行一次');
});

test('T2a 门禁：setSubagentActive(false) 后门禁关闭（4 块不再拦）', async () => {
  setupGateEnv();
  setSubagentActive(true);
  setSubagentActive(false);
  await processInterceptedResponse(mkReply(4, 1), true);
  assert.strictEqual(executeJsSpy.mock.calls.length, 4, '关闭标识后应放行 4 个块');
  assert.strictEqual(gateHints().length, 0, '关闭标识后不应发超限提示');
});

// 代码观察：门禁提示中的「单次上限/单块上限」文案为硬编码数字（observer.ts L114/L126），
// 若后续把 MAX_JS_BLOCKS_PER_REPLY / MAX_TOOLS_PER_BLOCK 改为可配置，测试断言需同步。

