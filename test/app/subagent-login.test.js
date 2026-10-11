'use strict';
/**
 * T2e 子代理登录检测 + worker partition 降级 —— 单元 / 集成测试
 *
 * 被测：src/app/subagent.ts（唯一改动文件）
 *   - _whenPageReady（did-finish-load 门控 + 1500ms，Blocker-1 / Minor-1）
 *   - _checkLogin（恒返回对象、永不返回 null，Major-1 / Minor-2）——未 export，经可观测行为断言
 *   - _attachClosedHandler（初始 + 降级窗口共用，Major-2）
 *   - runAgent partition 缺失回落 WORKER_PARTITION（Minor-3）
 *   - 降级窗口 name 含 agentName（Nit-3）
 *
 * 权威源：docs/reviews/T2e-fix-report.md §二/§六、docs/reviews/T2e-rereview.md §2/§3
 * 契约：docs/architecture.md T2e 段（_checkLogin 恒返回对象、did-finish-load 门控）
 *
 * 关键实测（T2e-fix-report §六.4）：vi.useFakeTimers() **不接管** node:timers/promises 的 setTimeout
 *   （probe：fake 下 delay(1500) 经 advanceTimersByTimeAsync(1500) 后 done=false）。
 *   => _whenPageReady 的 LOGIN_CHECK_DELAY_MS 走真实计时器，测试用真实短等待推进。
 *   为让测试快且确定，统一让替身 view.webContents 走「无 once」或「isLoading()===false」短延迟分支，
 *   真实等待 LOGIN_CHECK_DELAY_MS(1500ms) 后断言（vitest testTimeout=30000 足够）。
 *
 * _checkLogin 未 export -> 用可观测行为断言语义：
 *   - view-destroyed / execute-error -> 走降级：新增一个 worker partition 窗口（createdWins 增长）
 *   - loggedIn:true                  -> 不走降级：不新建窗口 + 写 pendingProjectDir
 *
 * 自检（变更点 -> 用例 -> 触发逻辑 -> 覆盖场景）：
 *   1 Blocker-1 页面加载中不误判 -> it#1：once+isLoading=true，事件前不调 executeJavaScript；触发后调 正常+边界
 *   2 Major-1 view 已销毁         -> it#2：view=null -> 走降级（不返回 null 跳过），且未误执行 JS 异常
 *   3 execute-error              -> it#3：executeJavaScript reject -> 降级 + 二次失败 -> reject 异常
 *   4 已登录                     -> it#4：{loggedIn:true} -> 不降级 + 写 pendingProjectDir 正常
 *   5 Minor-1 降级二次门控        -> it#5：降级新窗口 isLoading 恒 true，事件前二次检测不执行 正常+边界
 *   6 Major-2 closed handler     -> it#6：初始窗 on('closed') 注册；触发->reject /子窗口被手动关闭/；state.win!==win 不误终止 正常+边界
 *   7 Minor-3 partition 回落      -> it#7：createSubagentProfile 无 partition -> WORKER_PARTITION 边界
 *   8 Nit-3 window name          -> it#8：agentName 存在/'通用'兜底/subagentConfig 为 null 安全 正常+边界
 *
 * 隔离：mock createRequire('electron')（外部边界）；activeTasks / _taskSeq 模块级 -> 每用例 resetModules 重 import。
 */

import { test, describe, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';

const ho = vi.hoisted(() => {
  const electron = {
    app: { getPath: () => '' },
    ipcRenderer: { invoke: vi.fn(() => Promise.resolve({ success: true })) },
    ipcMain: { handle: () => {} },
  };
  return { electron };
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

// 常量（对齐 src/app/subagent.ts L86-89）
const WORKER_PARTITION = 'persist:subagent-worker';
const LOGIN_CHECK_DELAY_MS = 1500;

const ORIG_ARGV = process.argv.slice();

let subagent;
let windowState;

beforeEach(() => {
  // 不用 fake timers：SUT 的 _whenPageReady 用 node:timers/promises 的 setTimeout（不被 fake 接管），
  // 若在此 fake 全局 setTimeout 会导致测试自身的 realDelay 永不触发（探针实测结论）。
  // 本文件全部走真实计时器 + 真实短等待；SUT 的 60s/15min 任务计时器在 1.5s 窗口内不会触发。
  vi.resetModules();
  return Promise.all([
    import('../../src/app/subagent.js'),
    import('../../src/app/window.js'),
  ]).then(([s, w]) => {
    subagent = s;
    windowState = w;
  });
});

afterEach(() => {
  vi.resetModules();
  process.argv = ORIG_ARGV.slice();
});

// ---------- 脚手架 ----------

/** 真实等待 _whenPageReady 的 delay(LOGIN_CHECK_DELAY_MS)（fake timers 不管 timers/promises） */
function realDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 冲刷微任务（promise 链推进） */
function flushMicrotasks(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 8); i++) p = p.then(() => {});
  return p;
}

function acc(id, providerId) {
  return { id, providerId, partition: 'persist:' + providerId + ':' + id };
}

/**
 * 起一个子代理任务。
 * @param opts.partitionNull  true -> createSubagentProfile 不返回 partition（Minor-3）
 * @param opts.agentName      透传给 createSubagentProfile（Nit-3）
 * @param opts.viewWc         自定义 view.webContents（登录路径用）
 * @param opts.projectDir     父窗口项目目录（供 _handleLoggedIn 断言）
 */
function startTask(opts) {
  opts = opts || {};
  const providerId = opts.providerId || 'deepseek';
  const profiles = [acc('main', providerId), acc('sub', providerId)];
  const pm = {
    readProfiles: () => profiles,
    getLastActiveProfileId: () => 'main',
    createSubagentProfile: (account, agentName) => {
      const p = {
        id: 'subagent-tmp', providerId: account.providerId,
        name: '子代理:' + agentName, isSubagent: true,
      };
      if (!opts.partitionNull) p.partition = account.partition;
      return p;
    },
  };
  const winWc = { tag: 'win', send: vi.fn(), isDestroyed: () => false };
  const viewWc = opts.viewWc || { tag: 'view', send: vi.fn(), isDestroyed: () => false };
  const win = { id: 900, webContents: winWc, isDestroyed: () => false, close: vi.fn(), on: vi.fn() };
  const view = { webContents: viewWc, isDestroyed: () => false };
  const store = { state: { selectedProjectDir: opts.projectDir || null } };

  const parentStore = { state: { selectedProjectDir: opts.projectDir || null } };
  windowState.addWindow({ id: 1, webContents: { tag: 'parent' }, on: () => {} }, 'main', providerId, parentStore, null, false);

  // createWindow 每次调用注册一个新窗口，返回其 id（降级重建会二次调用）
  const createdWins = [];
  let nextId = 900;
  subagent.injectSubagentDeps({
    createWindow: (profile) => {
      nextId += 1;
      const w = { id: nextId, webContents: winWc, isDestroyed: () => false, close: vi.fn(), on: vi.fn() };
      const v = { webContents: viewWc, isDestroyed: () => false };
      windowState.addWindow(w, profile.id, profile.providerId, store, v, true);
      createdWins.push({ win: w, view: v, profile });
      return w.id;
    },
    profileManager: pm,
  });
  // 初始窗口（id 900）也注册，供首个 runAgent 取得 state.win/state.view
  windowState.addWindow(win, 'subagent-tmp', providerId, store, view, true);

  const p = subagent.runAgent({
    parentWindowId: 1, agentName: opts.agentName || 'a', task: 't', systemPrompt: 's',
    timeoutMs: opts.timeoutMs,
  });
  p.catch(() => {});

  const state = subagent.findTaskByWebContents(viewWc);
  assert.ok(state, 'runAgent 应同步注册任务到 activeTasks');
  return { p, win, winWc, view, viewWc, store, state, pm, createdWins };
}

// =====================================================================
// 1. _checkLogin 路径（经 _whenPageReady 门控）
// =====================================================================

describe('_checkLogin 登录检测（经 did-finish-load 门控）', () => {
  test('Blocker-1：页面加载中（once + isLoading()===true）executeJavaScript 在 did-finish-load 前不被调用，触发后（+1500ms）才调用', () => {
    let finishLoadCb = null;
    const execCalls = [];
    const viewWc = {
      tag: 'view', send: vi.fn(), isDestroyed: () => false,
      isLoading: () => true,
      once: (ev, cb) => { if (ev === 'did-finish-load' && !finishLoadCb) finishLoadCb = cb; },
      executeJavaScript: (js) => { execCalls.push(js); return Promise.resolve({ loggedIn: false, reason: 'no-chat-input' }); },
    };
    startTask({ viewWc });

    // 事件未触发：绝不能调 executeJavaScript（否则会在空白页误判未登录）
    return realDelay(LOGIN_CHECK_DELAY_MS + 200).then(() => {
      assert.strictEqual(execCalls.length, 0, 'did-finish-load 前不得执行登录检测 JS');
      assert.strictEqual(typeof finishLoadCb, 'function', '应已注册 did-finish-load once');
      finishLoadCb();
      return realDelay(LOGIN_CHECK_DELAY_MS + 200);
    }).then(() => {
      assert.strictEqual(execCalls.length, 1, 'did-finish-load 后再叠加 1500ms 才执行检测');
    });
  });

  test('Major-1：state.view 为 null -> 走降级（非静默跳过），且未误执行 JS', () => {
    const execCalls = [];
    const viewWc = {
      tag: 'view', send: vi.fn(), isDestroyed: () => false,
      executeJavaScript: (js) => { execCalls.push(js); return Promise.resolve({ loggedIn: true }); },
    };
    const env = startTask({ viewWc });
    // runAgent 内 _whenPageReady 已同步读取 view；此处置空 -> 延迟后 _checkLogin 读到 null
    env.state.view = null;
    return realDelay(LOGIN_CHECK_DELAY_MS + 300).then(() => flushMicrotasks(12)).then(() => {
      assert.ok(env.createdWins.length >= 2, 'view-destroyed 应触发降级重建窗口（而非返回 null 跳过）');
      assert.strictEqual(env.state.currentPartition, WORKER_PARTITION);
    });
  });

  test('Major-1：webContents.isDestroyed()===true -> 走降级', () => {
    let destroyed = false;
    const viewWc = {
      tag: 'view', send: vi.fn(),
      isDestroyed: () => destroyed,
      executeJavaScript: () => Promise.resolve({ loggedIn: true }),
    };
    const env = startTask({ viewWc });
    destroyed = true; // 延迟后 _checkLogin 读到已销毁
    return realDelay(LOGIN_CHECK_DELAY_MS + 300).then(() => flushMicrotasks(12)).then(() => {
      assert.ok(env.createdWins.length >= 2, 'isDestroyed -> view-destroyed -> 降级');
    });
  });

  test('异常：executeJavaScript reject -> 降级，二次检测仍失败 -> runAgent reject /worker partition 未登录/', () => {
    const viewWc = {
      tag: 'view', send: vi.fn(), isDestroyed: () => false,
      executeJavaScript: () => Promise.reject(new Error('boom-xyz')),
    };
    const env = startTask({ viewWc });
    return assert.rejects(env.p, /worker partition 未登录/);
  });

  test('已登录：executeJavaScript 返回 {loggedIn:true} -> 不降级 + 写 pendingProjectDir', () => {
    const viewWc = {
      tag: 'view', send: vi.fn(), isDestroyed: () => false,
      executeJavaScript: () => Promise.resolve({ loggedIn: true }),
    };
    const env = startTask({ viewWc, projectDir: 'D:/proj-x' });
    return realDelay(LOGIN_CHECK_DELAY_MS + 300).then(() => flushMicrotasks(12)).then(() => {
      const fb = env.createdWins.filter((w) => String(w.profile.id).indexOf('subagent-worker-') === 0);
      assert.strictEqual(fb.length, 0, '已登录不应新建降级窗口（createdWins[0] 是初始窗口）');
      assert.strictEqual(env.state.currentPartition, 'persist:deepseek:sub', 'partition 不应变为 worker');
      assert.strictEqual(env.store.state.pendingProjectDir, 'D:/proj-x', '_handleLoggedIn 应写 pendingProjectDir');
    });
  });

  // 2026-10-01：修复「/登录/ 宽匹配误判」的回归保护。
  //   现有用例全 mock executeJavaScript 返回值，碰不到注入的 LOGIN_CHECK_JS 逻辑 →
  //   此前宽匹配把「退出登录」「xxx登录」判为未登录的 bug 无测试可捕获。
  //   本用例捕获注入的 JS 字符串，用受控 fake DOM 求值，断言判定结果。
  test('LOGIN_CHECK_JS：含"登录"字样的长文本不误判未登录（宽匹配回归保护）', () => {
    const execCalls = [];
    const viewWc = {
      tag: 'view', send: vi.fn(), isDestroyed: () => false,
      executeJavaScript: (js) => { execCalls.push(js); return Promise.resolve({ loggedIn: true }); },
    };
    startTask({ viewWc });
    return realDelay(LOGIN_CHECK_DELAY_MS + 200).then(() => {
      assert.strictEqual(execCalls.length, 1, '应注入一次登录检测 JS');
      const js = execCalls[0];
      const mkBtn = (text, w, h) => ({ textContent: text, getBoundingClientRect: () => ({ width: w, height: h }) });
      const evalWith = (buttons) => {
        const fakeDoc = {
          querySelector: (sel) => (sel === 'textarea' ? {} : null),
          querySelectorAll: () => buttons,
        };
        const fakeLoc = { href: 'https://chat.deepseek.com/' };
        // eslint-disable-next-line no-new-func
        return new Function('location', 'document', 'return ' + js)(fakeLoc, fakeDoc);
      };
      // 已登录，页面上有含"登录"的长文本 → 不得误判未登录
      assert.strictEqual(evalWith([mkBtn('退出登录', 60, 30)]).loggedIn, true, '「退出登录」不应误判未登录');
      assert.strictEqual(evalWith([mkBtn('张三的登录记录', 100, 20)]).loggedIn, true, '含登录的标题不应误判未登录');
      // 真未登录：纯登录入口短文本 → 判未登录
      assert.strictEqual(evalWith([mkBtn('登录', 80, 36)]).loggedIn, false, '「登录」应判未登录');
      assert.strictEqual(evalWith([mkBtn('微信登录', 100, 36)]).loggedIn, false, '「微信登录」应判未登录');
      // 无按钮 → 已登录
      assert.strictEqual(evalWith([]).loggedIn, true, '无登录按钮应判已登录');
      // 不可见登录按钮（0 尺寸）→ 不判未登录
      assert.strictEqual(evalWith([mkBtn('登录', 0, 0)]).loggedIn, true, '不可见登录按钮不应判未登录');
    });
  });
});

// =====================================================================
// 2. 降级路径：二次检测同样经 did-finish-load 门控（Minor-1）
// =====================================================================

describe('降级到 worker partition（二次检测门控 Minor-1）', () => {
  test('Minor-1：降级新窗口 isLoading 恒 true -> 二次 executeJavaScript 在 did-finish-load 触发前不被调用', () => {
    const execCalls = [];
    let onceCount = 0;
    let fallbackFinishCb = null;
    const viewWc = {
      tag: 'view', send: vi.fn(), isDestroyed: () => false,
      isLoading: () => true,
      once: (ev, cb) => {
        if (ev !== 'did-finish-load') return;
        onceCount += 1;
        if (onceCount === 1) queueMicrotask(cb); // 首次检测页立即就绪 -> 触发
        else fallbackFinishCb = cb;              // 降级二次检测：手动控制
      },
      executeJavaScript: () => { execCalls.push(1); return Promise.resolve({ loggedIn: false, reason: 'no-chat-input' }); },
    };
    const env = startTask({ viewWc });

    return realDelay(LOGIN_CHECK_DELAY_MS + 300).then(() => flushMicrotasks(12)).then(() => {
      assert.strictEqual(env.state.currentPartition, WORKER_PARTITION, '应已降级到 worker partition');
      assert.strictEqual(typeof fallbackFinishCb, 'function', '降级窗口应注册 did-finish-load once');
      const before = execCalls.length;
      return realDelay(LOGIN_CHECK_DELAY_MS + 200).then(() => {
        assert.strictEqual(execCalls.length, before, '降级二次检测在 did-finish-load 前不得执行');
        fallbackFinishCb();
        return realDelay(LOGIN_CHECK_DELAY_MS + 200);
      }).then(() => {
        assert.strictEqual(execCalls.length, before + 1, 'did-finish-load 后二次检测才执行');
      });
    });
  });
});

// =====================================================================
// 3. _attachClosedHandler（Major-2）
// =====================================================================

describe('_attachClosedHandler（初始窗口注册 Major-2）', () => {
  test('初始子窗口 on(\'closed\') 被注册；触发 -> reject /子窗口被手动关闭/', () => {
    const env = startTask({});
    // state.win 是 createWindow 创建的窗口（createdWins[0]），非单独注册的 env.win
    const initialWin = env.createdWins[0].win;
    const closedRegs = initialWin.on.mock.calls.filter((c) => c[0] === 'closed');
    // 初始窗口的 on('closed') 有 2 处注册：windowState.addWindow（清 map）+ _attachClosedHandler（失败任务）
    assert.ok(closedRegs.length >= 1, '初始窗口应注册 closed handler（含 _attachClosedHandler）');

    closedRegs.forEach((c) => c[1]());
    assert.strictEqual(env.state.phase, 'failed');
    return assert.rejects(env.p, /子窗口被手动关闭/);
  });

  test('边界：state.win !== win（降级后旧窗关闭）-> 不误终止', () => {
    const env = startTask({});
    const initialWin = env.createdWins[0].win;
    const closedCb = initialWin.on.mock.calls.filter((c) => c[0] === 'closed')[0][1];
    const otherWin = { id: 999, isDestroyed: () => false, close: vi.fn(), on: () => {} };
    env.state.win = otherWin; // 模拟已换成新窗口

    closedCb();
    assert.notStrictEqual(env.state.phase, 'failed', 'state.win 已变 -> 不应终止任务');
    assert.ok(subagent.findTaskByWebContents(env.viewWc), '任务应仍在注册表');
  });
});

// =====================================================================
// 4. runAgent partition 回落（Minor-3）
// =====================================================================

describe('runAgent partition 缺失回落 WORKER_PARTITION（Minor-3）', () => {
  test('createSubagentProfile 不返回 partition -> 建窗 profile.partition === WORKER_PARTITION，state.currentPartition 同步', () => {
    const env = startTask({ partitionNull: true });
    assert.strictEqual(env.state.currentPartition, WORKER_PARTITION);
    assert.strictEqual(env.createdWins[0].profile.partition, WORKER_PARTITION);
  });

  test('边界：partition 存在 -> 保留原值，不回落', () => {
    const env = startTask({});
    assert.strictEqual(env.state.currentPartition, 'persist:deepseek:sub');
    assert.strictEqual(env.createdWins[0].profile.partition, 'persist:deepseek:sub');
  });
});

// =====================================================================
// 5. 降级窗口 name（Nit-3）
// =====================================================================

describe('降级窗口 name 含 agentName（Nit-3）', () => {
  function fallbackViewWc() {
    return {
      tag: 'view', send: vi.fn(), isDestroyed: () => false,
      isLoading: () => false, // 已加载完 -> 短延迟分支
      executeJavaScript: () => Promise.resolve({ loggedIn: false, reason: 'no-chat-input' }),
    };
  }

  test('agentName 存在 -> name === \'子 Agent - \' + agentName', () => {
    const env = startTask({ viewWc: fallbackViewWc(), agentName: 'Researcher' });
    return realDelay(LOGIN_CHECK_DELAY_MS + 300).then(() => flushMicrotasks(12)).then(() => {
      const fb = env.createdWins.filter((w) => String(w.profile.id).indexOf('subagent-worker-') === 0);
      assert.ok(fb.length >= 1, '应发生降级重建');
      const p = fb[0].profile;
      assert.strictEqual(p.name, '子 Agent - Researcher');
      assert.strictEqual(p.partition, WORKER_PARTITION);
      assert.strictEqual(p.subagentConfig.agentName, 'Researcher');
    });
  });

  test('边界：subagentConfig 为 null 时 name 回落「通用」，不抛错', () => {
    const env = startTask({ viewWc: fallbackViewWc() });
    env.state.subagentConfig = null;
    return realDelay(LOGIN_CHECK_DELAY_MS + 300).then(() => flushMicrotasks(12)).then(() => {
      const fb = env.createdWins.filter((w) => String(w.profile.id).indexOf('subagent-worker-') === 0);
      assert.ok(fb.length >= 1, '应发生降级重建');
      assert.strictEqual(fb[0].profile.name, '子 Agent - 通用');
    });
  });
});
