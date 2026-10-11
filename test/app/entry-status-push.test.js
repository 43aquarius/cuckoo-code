'use strict';
/**
 * T10 三次修复 TD3：entry.ts 子代理状态推送编排 —— 单元测试
 *
 * 被测：src/app/entry.ts L546-579（broadcastSubagentStatus + setStatusChangeHandler 编排）
 *   1) broadcastSubagentStatus：仅推非子代理窗口；跳过 isSubagent / 已销毁窗口
 *   2) ticker 启停：有任务 -> 幂等启动 1s interval，每 tick 用 getStatusList() 重推；
 *      空列表 -> 广播空列表并 clearInterval（ticker 内 length===0 亦自停）
 *
 * 隔离：entry.ts 含 app.whenReady 等重副作用，故 mock 外部边界——
 *   - node:module.createRequire -> 伪 electron（app/BrowserWindow/Menu/ipcMain 全打桩；
 *     whenReady 返回永不 resolve 的 Promise，阻断 createWindow/setupAppMenu 真执行）
 *   - src/updater/index.js（electron-updater 在 Node 下构造即抛 getVersion）
 *   - src/feishu/client.js（真实 connect 会发起网络连接）
 *   - src/app/subagent.js：仅替换 setStatusChangeHandler（捕获 entry 注册的 handler）与
 *     getStatusList（可控返回值 + 计数），其余导出透传。
 *   window.js 用真实实现（与 entry 同一模块实例），窗口经 addWindow 真实注册。
 *   CUCKOO_SESSION_DIR 指向临时目录，避免污染仓库会话目录。
 */
import { test, describe, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';

process.env.CUCKOO_SESSION_DIR = path.join(os.tmpdir(), 'cuckoo-t10-entry-' + process.pid);
// feishu config.ts 的 readConfig() 读 CUCKOO_HOME（默认 ~/.cuckoo/feishu.json）。entry.ts 模块加载即
// 执行 initFeishu()，若不隔离会读宿主机真实配置导致测试非密闭。指向临时目录 -> 配置不存在 -> disabled 分支。
process.env.CUCKOO_HOME = path.join(os.tmpdir(), 'cuckoo-t10-entry-home-' + process.pid);

const ho = vi.hoisted(() => ({
  electron: {
    app: {
      getPath: () => '',
      getAppPath: () => process.cwd(),
      setPath: () => {},
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      on: () => {},
      whenReady: () => new Promise(() => {}),
      quit: () => {},
    },
    BrowserWindow: class {},
    WebContentsView: class {},
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    dialog: {},
    ipcMain: { handle: () => {}, on: () => {} },
  },
  captured: { handler: null },
  tasks: [],
  getStatusList: vi.fn(),
}));

vi.mock('node:module', (io) =>
  io().then((a) => ({ ...a, createRequire: () => () => ho.electron })),
);
vi.mock('../../src/updater/index.js', () => ({ initAutoUpdater: () => {} }));
vi.mock('../../src/feishu/client.js', () => ({
  connect: () => ({ success: true }),
  disconnect: () => {},
  sendText: () => {},
  getStatus: () => ({ status: 'disconnected', detail: '' }),
  readConfig: () => ({ enabled: false }),
  listChats: () => [],
}));
vi.mock('../../src/app/subagent.js', (io) =>
  io().then((a) => ({
    ...a,
    injectSubagentDeps: () => {},
    runAgent: () => Promise.resolve(''),
    setStatusChangeHandler: (fn) => { ho.captured.handler = fn; },
    getStatusList: ho.getStatusList,
  })),
);

let windowState;
let handler;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.resetModules();
  ho.captured.handler = null;
  ho.tasks = [];
  ho.getStatusList.mockReset();
  ho.getStatusList.mockImplementation(() => ho.tasks);
  const entryP = import('../../src/app/entry.js');
  await entryP;
  const wsP = import('../../src/app/window.js');
  windowState = await wsP;
  handler = ho.captured.handler;
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** 注册一个窗口到真实 windowState，返回 send 桩 */
function addWin(id, isSubagent, opts) {
  opts = opts || {};
  const send = vi.fn(() => {
    if (opts.sendThrows) throw new Error('send boom');
  });
  const win = { id, webContents: { send }, isDestroyed: () => !!opts.destroyed, on: () => {} };
  windowState.addWindow(win, 'p' + id, 'deepseek', {}, { webContents: {} }, isSubagent);
  return send;
}

function task(id) {
  return { taskId: id, agentType: 'a', provider: 'deepseek', elapsedMs: 0, windowId: 1 };
}

describe('entry.ts 子代理状态推送编排（T10 / TD3）', () => {
  test('entry 启动即向 subagent 注册状态变更 handler', () => {
    assert.strictEqual(typeof handler, 'function');
  });

  test('仅推非子代理窗口；跳过 isSubagent 与已销毁窗口', () => {
    const shell = addWin(801, false);
    const sub = addWin(802, true);
    const dead = addWin(803, false, { destroyed: true });
    const t = task('t1');

    handler([t]);

    assert.strictEqual(shell.mock.calls.length, 1);
    assert.deepStrictEqual(shell.mock.calls[0][0], 'subagent-status');
    assert.deepStrictEqual(shell.mock.calls[0][1], { tasks: [t] });
    assert.strictEqual(sub.mock.calls.length, 0, '子代理窗口不应收到状态推送');
    assert.strictEqual(dead.mock.calls.length, 0, '已销毁窗口应跳过');
  });

  test('有任务 -> 启动 1s ticker，每 tick 用 getStatusList() 重推', () => {
    const shell = addWin(811, false);
    ho.tasks = [task('t1')];
    handler(ho.tasks);
    assert.strictEqual(shell.mock.calls.length, 1, '注册变更应立即广播一次');

    ho.tasks = [task('t2')];
    vi.advanceTimersByTime(1000);
    assert.strictEqual(shell.mock.calls.length, 2);
    assert.deepStrictEqual(shell.mock.calls[1][1], { tasks: [task('t2')] }, 'tick 应重取 getStatusList()');
    assert.strictEqual(ho.getStatusList.mock.calls.length, 1);
  });

  test('ticker 幂等：连续有任务变更不叠加 interval', () => {
    const shell = addWin(821, false);
    ho.tasks = [task('t1')];
    handler(ho.tasks);
    handler(ho.tasks);
    assert.strictEqual(shell.mock.calls.length, 2, '两次变更各广播一次');

    vi.advanceTimersByTime(1000);
    assert.strictEqual(shell.mock.calls.length, 3, '仅一个 interval -> 一 tick 只多一次推送');
  });

  test('空列表 -> 广播空列表且不启动 ticker', () => {
    const shell = addWin(831, false);
    handler([]);
    assert.deepStrictEqual(shell.mock.calls[0][1], { tasks: [] });

    vi.advanceTimersByTime(3000);
    assert.strictEqual(shell.mock.calls.length, 1, '无任务不应有 ticker');
    assert.strictEqual(ho.getStatusList.mock.calls.length, 0);
  });

  test('任务清空 -> ticker 内 length===0 自停，后续不再轮询', () => {
    const shell = addWin(841, false);
    ho.tasks = [task('t1')];
    handler(ho.tasks);
    assert.strictEqual(ho.getStatusList.mock.calls.length, 0);

    ho.tasks = [];
    vi.advanceTimersByTime(1000);
    assert.strictEqual(ho.getStatusList.mock.calls.length, 1, 'tick 取到空列表');
    assert.deepStrictEqual(shell.mock.calls[1][1], { tasks: [] });

    vi.advanceTimersByTime(5000);
    assert.strictEqual(ho.getStatusList.mock.calls.length, 1, 'ticker 应已自停');
    assert.strictEqual(shell.mock.calls.length, 2);
  });

  test('非空 -> 空变更 -> clearInterval，不再轮询', () => {
    const shell = addWin(851, false);
    ho.tasks = [task('t1')];
    handler(ho.tasks);
    handler([]);
    assert.strictEqual(shell.mock.calls.length, 2);

    vi.advanceTimersByTime(5000);
    assert.strictEqual(ho.getStatusList.mock.calls.length, 0, 'clearInterval 后 ticker 不再触发');
    assert.strictEqual(shell.mock.calls.length, 2);
  });

  test('窗口 send 抛错被吞掉，不影响其他窗口', () => {
    addWin(861, false, { sendThrows: true });
    const shell = addWin(862, false);
    assert.doesNotThrow(() => handler([task('t1')]));
    assert.strictEqual(shell.mock.calls.length, 1);
  });
});
