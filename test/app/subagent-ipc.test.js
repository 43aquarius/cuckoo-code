'use strict';
/**
 * T2f 子代理 IPC 面 —— 单元 / 集成测试
 *
 * 被测：
 *   - src/app/subagent.ts        abortByWindowId(L281) / focusByWindowId(L298) / getStatusList(L318)
 *   - src/app/ipc/subagent.ts    subagent-abort(L48) / focus-subagent-window(L55) / get-agent-list(L66)
 *                                get-subagent-status（T10 侧边栏「子代理」面板）
 *
 * 契约（docs/plans/subagent-port-spec.md AC-7 L139-144；docs/reviews/T2f-review.md §二/§三）：
 *   - subagent-abort { windowId }：非 number -> { success:false, error:'windowId 非法' }（m-3）；命中 -> abortByWindowId
 *     中止任务（reason「子 Agent 任务已被用户中止」）；未命中 -> { success:false }
 *   - focus-subagent-window { windowId }：非 number -> error 分支；命中且未销毁 -> restore(若最小化)+focus
 *   - get-agent-list：agents = scanAgents(当前窗 projectDir)；agentDir 回落 ~/.cuckoo/agents
 *   - getStatusList：windowId 取 state.windowId（恒 number，无 null）；仅 starting/working/force_deliver
 *
 * 自检（变更点 -> 用例 -> 触发逻辑 -> 覆盖场景）：
 *   1 abortByWindowId 命中/未命中/幂等   -> 3 例（reject /用户中止/ + 注册表移除；未命中任务存活；重复中止 false）正常+边界
 *   2 focusByWindowId 命中/最小化/销毁   -> 5 例（focus-only / restore+focus / isDestroyed 跳过 / id 不匹配 / 未最小化不 restore）正常+边界
 *   3 getStatusList 类型收窄              -> 4 例（windowId number / state.win=null 重建期仍 number / failed 后过滤 / 空注册表）正常+边界+异常
 *   4 subagent-abort 非法 windowId        -> 3 例（'3' / 缺省·undefined / null·true·object -> error 分支，任务不受影响）边界
 *   5 subagent-abort NaN 代码观察 1       -> 1 例（NaN 过 typeof 守卫 -> { success:false } 无 error）边界
 *   6 subagent-abort 合法命中/未命中      -> 2 例（{success:true}+reject 文案；未命中 {success:false}）正常+边界
 *   7 focus-subagent-window 非法/命中/未命中 -> 4 例 边界+正常
 *   8 get-agent-list projectDir 传递      -> 6 例（命中传 projectDir / 未设 null / 无法反查 null / event undefined / 抛错 / view sender）正常+边界+异常
 *
 * 隔离：mock createRequire('electron')（外部边界）与 ../../src/agents/index.js（扫描副作用，仅 get-agent-list 用）。
 *   subagent.js / window.js 均用真实实现（不 mock），保证 activeTasks 与 windows 是同一模块实例。
 *   activeTasks / _taskSeq / window.js windows 均为模块级状态 -> 每用例 vi.resetModules() 后重新 import。
 *   计时器：fake setTimeout（runAgent 的 60s/120min 任务计时器不触发）；SUT 的 node:timers/promises delay 不被 fake，
 *   但 _checkLogin 替身恒返回 { loggedIn:true } -> 无降级重建副作用。
 *   「不调 abortByWindowId / focusByWindowId」用可观测效果断言（任务仍存活 / focus 未被调用），不依赖 spy。
 */

import { test, describe, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';

// ---------- 外部边界 mock ----------

const ho = vi.hoisted(() => {
  const handlers = new Map();
  const electron = {
    app: { getPath: () => '' },
    ipcRenderer: { invoke: vi.fn(() => Promise.resolve({ success: true })) },
    ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); } },
  };
  return { electron, handlers, scanAgents: vi.fn(() => []) };
});

vi.mock('node:module', (importOriginal) =>
  importOriginal().then((actual) => ({
    ...actual,
    createRequire: () => (id) => {
      if (id === 'electron') return ho.electron;
      throw new Error('unexpected require: ' + id);
    },
  })),
);

// 只被测 get-agent-list 的 projectDir 传参 -> scanAgents 打桩，隔离文件系统
vi.mock('../../src/agents/index.js', () => ({
  scanAgents: ho.scanAgents,
  mergeAgents: () => [],
  buildAgentsSection: () => '',
}));

const DEFAULT_TIMEOUT_MS = 120 * 60 * 1000;

let subagent;    // src/app/subagent.js（真实实现）
let windowState; // src/app/window.js（真实实现）

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.resetModules();
  ho.handlers.clear();
  ho.scanAgents.mockReset();
  ho.scanAgents.mockReturnValue([]);
  return Promise.all([
    import('../../src/app/subagent.js'),
    import('../../src/app/window.js'),
  ]).then(([s, w]) => {
    subagent = s;
    windowState = w;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

// ---------- 脚手架 ----------

function flushMicrotasks(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 5); i++) p = p.then(() => {});
  return p;
}

function acc(id, providerId) {
  return { id, providerId, partition: 'persist:' + providerId + ':' + id };
}

/**
 * 起一个子代理任务（真实 runAgent），返回 state 与窗口句柄。
 * @param opts.windowId   壳窗口 id（默认 900）
 * @param opts.noCtx      true -> 不注册到 windowState（模拟重建期 state.win === null 但 windowId 有效）
 * @param opts.destroyed  壳窗口 isDestroyed() 恒 true
 * @param opts.minimized  壳窗口 isMinimized() 恒 true
 * @param opts.projectDir 子窗 sessionStore.state.selectedProjectDir 初值
 */
function startTask(opts) {
  opts = opts || {};
  const providerId = opts.providerId || 'deepseek';
  const profiles = [acc('main', providerId), acc('sub', providerId)];
  const pm = {
    readProfiles: () => profiles,
    getLastActiveProfileId: () => 'main',
    createSubagentProfile: (account, agentName) => ({
      id: 'subagent-tmp', providerId: account.providerId, partition: account.partition,
      name: '子代理:' + agentName, isSubagent: true,
    }),
  };

  const winWc = {
    tag: 'win', send: vi.fn(), isDestroyed: () => false,
    executeJavaScript: vi.fn(() => Promise.resolve({ loggedIn: true })),
  };
  const viewWc = {
    tag: 'view', send: vi.fn(), isDestroyed: () => false,
    executeJavaScript: vi.fn(() => Promise.resolve({ loggedIn: true })),
  };
  const winId = typeof opts.windowId === 'number' ? opts.windowId : 900;
  const agentName = opts.agentName !== undefined ? opts.agentName : 'a';
  const win = {
    id: winId,
    webContents: winWc,
    isDestroyed: () => !!opts.destroyed,
    isMinimized: () => !!opts.minimized,
    restore: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
  const view = { webContents: viewWc, isDestroyed: () => false };
  const store = { state: { selectedProjectDir: opts.projectDir || null } };

  subagent.injectSubagentDeps({
    createWindow: () => {
      // 始终注册窗口：runAgent 依赖 getWindowContext 取回 state.win/view
      // （「重建期 state.win === null」用例在取到 state 后手动置 null，见 nullOutWin）
      windowState.addWindow(win, 'subagent-tmp', providerId, store, view, true);
      return win.id;
    },
    profileManager: pm,
  });

  const p = subagent.runAgent({
    parentWindowId: 1,
    agentName,
    task: 't',
    systemPrompt: 's',
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  });
  p.catch(() => {}); // 标记已处理，避免未处理拒绝（断言处再 assert.rejects）

  const state = subagent.findTaskByWebContents(viewWc);
  assert.ok(state, 'runAgent 应同步注册任务到 activeTasks');
  assert.strictEqual(state.windowId, winId);
  return { p, win, winWc, view, viewWc, store, state, pm };
}

/**
 * 模拟「登录降级重建期」：state.win = null 但 state.windowId 仍持有效 id
 * （subagent.ts L484-486 _fallbackToWorker 内 state.win = null）。
 * ⚠ 直接置 null 而非不注册窗口——后者会让 findTaskByWebContents 反查不到 state。
 */
function nullOutWin(env) {
  env.state.win = null;
  env.state.view = null;
  return env;
}

/** 注册 4 个 handler，返回 { abort, focus, agentList, status } */
function registerIpc() {
  return import('../../src/app/ipc/subagent.js').then((ipc) => {
    ipc.registerSubagentIpc();
    ['subagent-abort', 'focus-subagent-window', 'get-agent-list', 'get-subagent-status'].forEach((ch) => {
      assert.ok(ho.handlers.has(ch), '应注册 handler: ' + ch);
    });
    return {
      abort: ho.handlers.get('subagent-abort'),
      focus: ho.handlers.get('focus-subagent-window'),
      agentList: ho.handlers.get('get-agent-list'),
      status: ho.handlers.get('get-subagent-status'),
    };
  });
}

// =====================================================================
// 1. abortByWindowId（subagent.ts L281-289）
// =====================================================================

describe('abortByWindowId（subagent.ts）', () => {
  test('命中：windowId 匹配 -> true，任务 reject reason 含「用户中止」，并从注册表移除', () => {
    const env = startTask({ windowId: 900 });
    assert.strictEqual(subagent.abortByWindowId(900), true, '命中应返回 true');
    assert.strictEqual(env.state.phase, 'failed');
    assert.strictEqual(subagent.getStatusList().length, 0, 'failed 后应移出注册表');
    return assert.rejects(env.p, /子 Agent 任务已被用户中止/);
  });

  test('未命中：windowId 不匹配 -> false，任务仍存活（phase/注册表不变）', () => {
    const env = startTask({ windowId: 900 });
    assert.strictEqual(subagent.abortByWindowId(12345), false);
    assert.strictEqual(env.state.phase, 'starting');
    assert.strictEqual(subagent.getStatusList().length, 1, '未命中不应影响任何任务');
    return flushMicrotasks().then(() => {
      assert.strictEqual(env.state.phase, 'starting');
      assert.ok(subagent.findTaskByWebContents(env.viewWc), '任务应仍在注册表');
    });
  });

  test('重复中止已终态任务 -> 第二次返回 false（_isTerminal 守卫，幂等）', () => {
    const env = startTask({ windowId: 900 });
    assert.strictEqual(subagent.abortByWindowId(900), true);
    assert.strictEqual(subagent.abortByWindowId(900), false, '已移除的任务不应再命中');
    return assert.rejects(env.p, /用户中止/);
  });
});

// =====================================================================
// 2. focusByWindowId（subagent.ts L298-308）
// =====================================================================

describe('focusByWindowId（subagent.ts）', () => {
  test('命中且未最小化 -> true，仅 focus()，不 restore()', () => {
    const env = startTask({ windowId: 900, minimized: false });
    assert.strictEqual(subagent.focusByWindowId(900), true);
    assert.strictEqual(env.win.focus.mock.calls.length, 1, '命中应 focus');
    assert.strictEqual(env.win.restore.mock.calls.length, 0, '未最小化不应 restore');
  });

  test('命中且最小化 -> true，先 restore() 再 focus()', () => {
    const env = startTask({ windowId: 901, minimized: true });
    assert.strictEqual(subagent.focusByWindowId(901), true);
    assert.strictEqual(env.win.restore.mock.calls.length, 1, '最小化应 restore');
    assert.strictEqual(env.win.focus.mock.calls.length, 1, '随后 focus');
  });

  test('边界：窗口已销毁 -> false，不 restore / 不 focus', () => {
    const env = startTask({ windowId: 902, destroyed: true });
    assert.strictEqual(subagent.focusByWindowId(902), false);
    assert.strictEqual(env.win.focus.mock.calls.length, 0);
    assert.strictEqual(env.win.restore.mock.calls.length, 0);
  });

  test('未命中：windowId 不匹配 -> false', () => {
    const env = startTask({ windowId: 903 });
    assert.strictEqual(subagent.focusByWindowId(999), false);
    assert.strictEqual(env.win.focus.mock.calls.length, 0);
  });

  test('边界：state.win 为 null（重建期）-> false，不抛错', () => {
    const env = nullOutWin(startTask({ windowId: 904 }));
    assert.strictEqual(subagent.focusByWindowId(904), false, 'state.win 为 null 时不应命中');
    assert.strictEqual(env.win.focus.mock.calls.length, 0);
  });
});

// =====================================================================
// 3. getStatusList（subagent.ts L318-331）
// =====================================================================

describe('getStatusList（subagent.ts）', () => {
  test('运行中任务：返回 taskId/agentType/elapsedMs/windowId，且 windowId 为 number', () => {
    startTask({ windowId: 950, agentName: 'req-writer' });
    const list = subagent.getStatusList();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(typeof list[0].windowId, 'number', 'windowId 类型应收窄为 number');
    assert.strictEqual(list[0].windowId, 950);
    assert.strictEqual(list[0].agentType, 'req-writer');
    assert.strictEqual(typeof list[0].taskId, 'string');
    assert.ok(list[0].elapsedMs >= 0, 'elapsedMs 应为非负数');
  });

  test('边界：agentName 未设 -> agentType 回落「通用」', () => {
    startTask({ windowId: 953, agentName: '' });
    const list = subagent.getStatusList();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].agentType, '通用');
  });

  test('边界：重建期 state.win === null 但 windowId 仍为有效 number', () => {
    nullOutWin(startTask({ windowId: 951 }));
    const list = subagent.getStatusList();
    assert.strictEqual(list.length, 1, 'state.win 为 null 不影响任务可见性');
    assert.strictEqual(typeof list[0].windowId, 'number');
    assert.strictEqual(list[0].windowId, 951);
  });

  test('异常/终态：任务失败后 -> 空数组（阶段过滤排除 failed）', () => {
    const env = startTask({ windowId: 952 });
    assert.strictEqual(subagent.getStatusList().length, 1);
    subagent.abortByWindowId(952);
    assert.deepStrictEqual(subagent.getStatusList(), []);
    return assert.rejects(env.p, /用户中止/);
  });

  test('无活跃任务 -> 返回空数组', () => {
    assert.deepStrictEqual(subagent.getStatusList(), []);
  });
});

// =====================================================================
// 4. IPC: subagent-abort
// =====================================================================

describe('IPC subagent-abort（ipc/subagent.ts L48-52）', () => {
  test("字符串 '3' -> { success:false, error:'windowId 非法' }，任务不受影响", () => {
    startTask({ windowId: 3 });
    return registerIpc()
      .then((ipc) => ipc.abort({ sender: {} }, { windowId: '3' }))
      .then((res) => {
        assert.deepStrictEqual(res, { success: false, error: 'windowId 非法' });
        assert.strictEqual(subagent.getStatusList().length, 1, '任务不应被中止');
      });
  });

  test('边界：缺省 payload（undefined）/ {} / { windowId: undefined } -> 一律 error 分支', () => {
    startTask({ windowId: 3 });
    return registerIpc()
      .then((ipc) => Promise.all([
        ipc.abort({ sender: {} }),
        ipc.abort({ sender: {} }, {}),
        ipc.abort({ sender: {} }, { windowId: undefined }),
      ]))
      .then((resList) => {
        resList.forEach((res) => {
          assert.deepStrictEqual(res, { success: false, error: 'windowId 非法' });
        });
        assert.strictEqual(subagent.getStatusList().length, 1, '任务不应被中止');
      });
  });

  test('边界：{ windowId: null } / { windowId: true } / { windowId: {} } -> error 分支', () => {
    startTask({ windowId: 3 });
    return registerIpc()
      .then((ipc) => Promise.all([
        ipc.abort({ sender: {} }, { windowId: null }),
        ipc.abort({ sender: {} }, { windowId: true }),
        ipc.abort({ sender: {} }, { windowId: {} }),
      ]))
      .then((resList) => {
        resList.forEach((res) => {
          assert.deepStrictEqual(res, { success: false, error: 'windowId 非法' });
        });
        assert.strictEqual(subagent.getStatusList().length, 1);
      });
  });

  test('边界（代码观察 1）：{ windowId: NaN } 通过 typeof number 守卫 -> 未命中返回 { success:false }（无 error 字段）', () => {
    startTask({ windowId: 3 });
    return registerIpc()
      .then((ipc) => ipc.abort({ sender: {} }, { windowId: NaN }))
      .then((res) => {
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, undefined, 'NaN 为 number 类型，不进 error 分支');
        assert.strictEqual(subagent.getStatusList().length, 1, 'NaN 永不命中，任务存活');
      });
  });

  test('合法 number 命中任务 -> { success:true }，且任务 reject reason 含「用户中止」', () => {
    const env = startTask({ windowId: 910 });
    return registerIpc()
      .then((ipc) => ipc.abort({ sender: {} }, { windowId: 910 }))
      .then((res) => {
        assert.deepStrictEqual(res, { success: true });
        assert.strictEqual(env.state.phase, 'failed');
        assert.strictEqual(subagent.getStatusList().length, 0);
        return assert.rejects(env.p, /子 Agent 任务已被用户中止/);
      });
  });

  test('合法 number 未命中 -> { success:false }（无 error 字段，对齐 051 n-2）', () => {
    startTask({ windowId: 911 });
    return registerIpc()
      .then((ipc) => ipc.abort({ sender: {} }, { windowId: 12345 }))
      .then((res) => {
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, undefined);
        assert.strictEqual(subagent.getStatusList().length, 1);
      });
  });
});

// =====================================================================
// 5. IPC: focus-subagent-window
// =====================================================================

describe('IPC focus-subagent-window（ipc/subagent.ts L55-59）', () => {
  test("windowId 非 number（'900' / null / undefined）-> { success:false, error:'windowId 非法' }", () => {
    startTask({ windowId: 920 });
    return registerIpc()
      .then((ipc) => Promise.all([
        ipc.focus({ sender: {} }, { windowId: '900' }),
        ipc.focus({ sender: {} }, { windowId: null }),
        ipc.focus({ sender: {} }),
      ]))
      .then((resList) => {
        resList.forEach((res) => {
          assert.deepStrictEqual(res, { success: false, error: 'windowId 非法' });
        });
      });
  });

  test('非法 windowId 时窗口不应被 focus（类型守卫先返回）', () => {
    const env = startTask({ windowId: 924 });
    return registerIpc()
      .then((ipc) => ipc.focus({ sender: {} }, { windowId: '924' }))
      .then((res) => {
        assert.strictEqual(res.success, false);
        assert.strictEqual(env.win.focus.mock.calls.length, 0, '类型守卫应先返回，不进入 focusByWindowId');
      });
  });

  test('合法 number 命中且最小化 -> { success:true }，restore + focus 各 1 次', () => {
    const env = startTask({ windowId: 921, minimized: true });
    return registerIpc()
      .then((ipc) => ipc.focus({ sender: {} }, { windowId: 921 }))
      .then((res) => {
        assert.deepStrictEqual(res, { success: true });
        assert.strictEqual(env.win.restore.mock.calls.length, 1);
        assert.strictEqual(env.win.focus.mock.calls.length, 1);
      });
  });

  test('合法 number 未命中 -> { success:false }（无 error 字段）', () => {
    startTask({ windowId: 922 });
    return registerIpc()
      .then((ipc) => ipc.focus({ sender: {} }, { windowId: 999 }))
      .then((res) => {
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, undefined);
      });
  });

  test('合法 number 但窗口已销毁 -> { success:false }，不 focus', () => {
    const env = startTask({ windowId: 923, destroyed: true });
    return registerIpc()
      .then((ipc) => ipc.focus({ sender: {} }, { windowId: 923 }))
      .then((res) => {
        assert.strictEqual(res.success, false);
        assert.strictEqual(env.win.focus.mock.calls.length, 0);
      });
  });
});

// =====================================================================
// 6. IPC: get-agent-list
// =====================================================================

describe('IPC get-agent-list（ipc/subagent.ts L66-76）', () => {
  const USER_AGENT_DIR = path.join(os.homedir(), '.cuckoo', 'agents');

  test('sender 命中窗口且 selectedProjectDir 已设 -> scanAgents 收到该 projectDir，返回 agents + agentDir', () => {
    const env = startTask({ windowId: 930, projectDir: 'E:/proj/alpha' });
    ho.scanAgents.mockReturnValue([
      { name: 'req-writer', description: '需求撰写' },
      { name: 'no-desc' },
    ]);
    return registerIpc()
      .then((ipc) => ipc.agentList({ sender: env.winWc }))
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.strictEqual(ho.scanAgents.mock.calls.length, 1);
        assert.strictEqual(ho.scanAgents.mock.calls[0][0], 'E:/proj/alpha', 'scanAgents 应收到窗口 projectDir');
        assert.deepStrictEqual(res.agents, [
          { id: 'req-writer', summary: '需求撰写' },
          { id: 'no-desc', summary: '' },
        ]);
        assert.strictEqual(res.agentDir, USER_AGENT_DIR);
      });
  });

  test('sender 命中窗口但未设 projectDir -> scanAgents(null)', () => {
    const env = startTask({ windowId: 931, projectDir: null });
    ho.scanAgents.mockReturnValue([{ name: 'x', description: 'd' }]);
    return registerIpc()
      .then((ipc) => ipc.agentList({ sender: env.winWc }))
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.strictEqual(ho.scanAgents.mock.calls[0][0], null);
        assert.deepStrictEqual(res.agents, [{ id: 'x', summary: 'd' }]);
      });
  });

  test('sender 无法反查窗口 -> scanAgents(null)（不抛错）', () => {
    ho.scanAgents.mockReturnValue([]);
    return registerIpc()
      .then((ipc) => ipc.agentList({ sender: { tag: 'unknown' } }))
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.strictEqual(ho.scanAgents.mock.calls[0][0], null);
        assert.deepStrictEqual(res.agents, []);
        assert.strictEqual(res.agentDir, USER_AGENT_DIR);
      });
  });

  test('边界：event 为 undefined -> ctx 反查失败，scanAgents(null)', () => {
    ho.scanAgents.mockReturnValue([]);
    return registerIpc()
      .then((ipc) => ipc.agentList(undefined))
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.strictEqual(ho.scanAgents.mock.calls[0][0], null);
      });
  });

  test('异常：scanAgents 抛错 -> { success:false, error }', () => {
    ho.scanAgents.mockImplementation(() => { throw new Error('EACCES: 目录无权限'); });
    return registerIpc()
      .then((ipc) => ipc.agentList({ sender: { tag: 'unknown' } }))
      .then((res) => {
        assert.strictEqual(res.success, false);
        assert.match(res.error, /EACCES/);
        assert.strictEqual(res.agents, undefined);
      });
  });

  test('sender 为 view.webContents（AI 页）同样可反查窗口', () => {
    const env = startTask({ windowId: 932, projectDir: 'E:/proj/beta' });
    ho.scanAgents.mockReturnValue([]);
    return registerIpc()
      .then((ipc) => ipc.agentList({ sender: env.viewWc }))
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.strictEqual(ho.scanAgents.mock.calls[0][0], 'E:/proj/beta');
      });
  });
});

// =====================================================================
// 7. IPC: get-subagent-status（T10，ipc/subagent.ts）
// =====================================================================

describe('IPC get-subagent-status（T10 侧边栏「子代理」面板）', () => {
  test('运行中任务：返回 { success:true, tasks }，任务项含 provider', () => {
    startTask({ windowId: 940, providerId: 'deepseek', agentName: 'code-reviewer' });
    return registerIpc()
      .then((ipc) => ipc.status())
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.tasks.length, 1);
        assert.strictEqual(res.tasks[0].provider, 'deepseek', 'provider 应透出任务平台 id');
        assert.strictEqual(res.tasks[0].agentType, 'code-reviewer');
        assert.strictEqual(res.tasks[0].windowId, 940);
      });
  });

  test('边界：无运行任务 -> { success:true, tasks:[] }', () => {
    return registerIpc()
      .then((ipc) => ipc.status())
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.deepStrictEqual(res.tasks, []);
      });
  });

  test('异常/终态：任务被中止后 -> 空数组', () => {
    const env = startTask({ windowId: 941 });
    subagent.abortByWindowId(941);
    return registerIpc()
      .then((ipc) => ipc.status())
      .then((res) => {
        assert.deepStrictEqual(res.tasks, []);
        return assert.rejects(env.p, /用户中止/);
      });
  });
});

// =====================================================================
// getStatusList 补充：provider 字段（T10）
// =====================================================================

describe('getStatusList provider 字段（T10）', () => {
  test('运行中任务 -> provider 取自 state.provider', () => {
    startTask({ windowId: 960, providerId: 'claude', agentName: 'reviewer' });
    const list = subagent.getStatusList();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].provider, 'claude');
  });

  test('边界：state.provider 为 null -> 字段为 null（非 undefined）', () => {
    const env = startTask({ windowId: 961, providerId: 'deepseek' });
    env.state.provider = null;
    assert.strictEqual(subagent.getStatusList()[0].provider, null);
  });
});

// =====================================================================
// T10 二次修复：状态变更推送钩子（setStatusChangeHandler / TD1）
// =====================================================================

describe('setStatusChangeHandler 状态变更推送（T10 二次修复）', () => {
  test('注册后：任务加入 -> 回调收到非空列表（含新任务）', () => {
    const calls = [];
    subagent.setStatusChangeHandler((tasks) => { calls.push(tasks); });
    startTask({ windowId: 970, agentName: 'watcher' });
    assert.ok(calls.length >= 1, '任务加入应触发回调');
    const last = calls[calls.length - 1];
    assert.strictEqual(last.length, 1);
    assert.strictEqual(last[0].agentType, 'watcher');
    subagent.setStatusChangeHandler(null);
  });

  test('任务完成/中止 -> 回调收到空列表（终态从注册表移除）', () => {
    const calls = [];
    subagent.setStatusChangeHandler((tasks) => { calls.push(tasks); });
    startTask({ windowId: 971 });
    subagent.abortByWindowId(971);
    const last = calls[calls.length - 1];
    assert.deepStrictEqual(last, [], '中止后末次回调应为空列表');
    subagent.setStatusChangeHandler(null);
  });

  test('传 null 注销 -> 后续任务变更不再触发回调', () => {
    let count = 0;
    subagent.setStatusChangeHandler(() => { count++; });
    subagent.setStatusChangeHandler(null);
    startTask({ windowId: 972 });
    assert.strictEqual(count, 0, '注销后不应再回调');
  });

  test('回调抛错 -> 吞掉异常，不阻断任务注册（有任务仍可见）', () => {
    subagent.setStatusChangeHandler(() => { throw new Error('boom'); });
    startTask({ windowId: 973 });
    assert.strictEqual(subagent.getStatusList().length, 1, '回调异常不应影响 activeTasks');
    subagent.setStatusChangeHandler(null);
  });

  test('回调收到的 tasks 快照即 getStatusList() 输出（字段一致）', () => {
    const calls = [];
    subagent.setStatusChangeHandler((tasks) => { calls.push(tasks); });
    startTask({ windowId: 974, providerId: 'glm', agentName: 'x' });
    const last = calls[calls.length - 1];
    assert.strictEqual(last[0].provider, 'glm');
    assert.strictEqual(last[0].windowId, 974);
    subagent.setStatusChangeHandler(null);
  });
});

// 代码观察 1：src/app/ipc/subagent.ts L49 / L56 用 `typeof windowId !== 'number'` 作守卫。
//   由于 typeof NaN === 'number'，{ windowId: NaN } 会通过守卫进入 abortByWindowId/focusByWindowId，
//   因严格比较永不命中而返回 { success:false }（无 error 字段），调用方无法区分「参数非法」与「未命中」。
//   与 m-3 目标（明确区分类型错）有差距；如需覆盖，可加 Number.isFinite(windowId) 判断。
//   本文件按实际行为断言（用例 4-4），未修改业务代码。
// 代码观察 2：src/app/ipc/subagent.ts L48 形参 `{ windowId }: any = {}` 仅在实参为 undefined 时启用默认值；
//   若渲染侧传 null 作为整个 payload（非 { windowId: null }），解构会抛 TypeError 并从 async handler 冒泡为 rejected promise。
//   当前无发送侧（M-1），暂不构成可达缺陷，故未写断言，仅记录。
