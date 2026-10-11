'use strict';
/**
 * T2b 子代理五层超时 + observer-ready 握手 —— 单元 / 集成测试
 *
 * 被测：
 *   - src/app/subagent.ts        五层超时状态机 + 握手 + 信号驱动（markActivity / recordRound）
 *   - src/bridge/subagent.ts     每轮回复上报 subagent-round（m-4：仅含工具块计轮）
 *   - src/app/ipc/subagent.ts    三个 IPC 处理器（subagent-candidate-result / subagent-ready / subagent-round）
 *
 * 契约（docs/plans/T2b-五层超时-实现报告.md §二/§三/§七；docs/reviews/T2b-rereview.md §二）：
 *   - 层1 总超时 120min（覆盖 starting + working）；层2 starting 60s（握手兜底）
 *   - 层3 空闲提醒 180s x2（GLM 12min），超限静默；层4 静默硬看门狗 15min
 *   - 层5 轮次硬顶 150 -> force_deliver（软着陆）
 *   - 握手：onSubagentReady(sender) -> starting->working，清 startingTimer（n-1：重复调用返回 false）
 *   - 只有真实活动（markActivity / recordRound）重置 silence；系统自身提醒不重置
 *   - m-4：bridge 仅含工具块才 invoke('subagent-round')；纯文本回复不计轮
 *
 * 自检（变更点 -> 用例 -> 覆盖场景）：
 *   1 层1 总超时      -> 3 例（自定义 5s / 边界 20ms / 默认 120min 保活）正常+边界
 *   2 层2 starting    -> 2 例（59.999s 未到 / 到点失败；握手后不再触发）边界+正常
 *   3 握手 + n-1      -> 4 例（首次 true / 重复 false / 非 starting false / 错误 sender false）异常
 *   4 层3 空闲提醒    -> 3 例（180s x2 后静默 / markActivity 归零 / GLM 12min）正常+边界
 *   5 层4 静默看门狗  -> 4 例（15min 失败 / markActivity 重置 / recordRound 重置 / 层3 不重置）正常+边界
 *   6 层5 轮次硬顶    -> 3 例（149 允许 / 150 force_deliver / 进入后不计数 / null 返回 false）正常+边界
 *   7 markActivity    -> 2 例（working true 重置双计时器 / force_deliver false 仅重置 silence）
 *   8 handleCandidateResult -> 9 例（正常 resolve / 空文本拒绝 / plain_text 不完成 / 未知 sender /
 *                                  starting 拒绝 / 未知 type / force_deliver 放行 / 完成幂等）
 *   9 m-4 bridge      -> 6 例（纯文本不计轮 / 含工具块计轮 / 空文本 / maxTurns / 未激活 / 混合输出工具块优先）
 *  10 IPC 集成        -> 7 例（ready x2 / round x2 / candidate x3）
 *
 * 隔离：mock createRequire('electron')（外部边界）；subagent.ts 只依赖 ./window.js（不加载 Electron）。
 * activeTasks / _taskSeq 为模块级状态 -> 每用例 vi.resetModules() 后重新 import，避免跨用例污染。
 * 本文件用 promise 链（.then）替代 async/await，与 test/main/subagent-pool.test.js 风格一致。
 */

import { test, describe, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';

// ---------- 外部边界 mock（vi.hoisted，避免工厂引用未初始化变量）----------

const ho = vi.hoisted(() => {
  const handlers = new Map();
  const invoke = vi.fn(() => Promise.resolve({ success: true }));
  const electron = {
    app: { getPath: () => '' },
    ipcRenderer: { invoke },
    ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); } },
  };
  return { electron, handlers, invoke, responseCb: null };
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

// bridge/subagent.ts 依赖 observer（真实模块会碰 window/document）-> 只保留两个导出
vi.mock('../../src/bridge/intercept/observer.js', () => ({
  onInterceptedResponse: (cb) => { ho.responseCb = cb; return () => {}; },
  setSubagentActive: () => {},
}));

// ---------- 常量（对齐 src/app/subagent.ts L65-75）----------
const MIN = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 120 * MIN;
const STARTING_TIMEOUT_MS = 60 * 1000;
const IDLE_TIMEOUT_MS = 180 * 1000;
const GLM_IDLE_TIMEOUT_MS = 12 * MIN;
const SILENCE_TIMEOUT_MS = 15 * MIN;
const MAX_INTERACTION_ROUNDS = 150;

// T2d：非敷衍的有效结果文本（>=30 字符、非敷衍话术开头、多句）——
// 短占位文本（如 'FINAL-TEXT'）会被 isTrivialResult 判为敷衍 → 追问不 resolve，故统一替换。
const VALID_RESULT = '检查完成：已阅读三个源文件，定位到两处逻辑缺陷。建议按修复方案 A 与 B 处理，并补充回归测试。';

const ORIG_ARGV = process.argv.slice();

let subagent;    // src/app/subagent.js
let windowState; // src/app/window.js

beforeEach(() => {
  // 只 fake 计时器，不 fake Date/performance（避免干扰 vitest 内部超时统计）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.resetModules();
  ho.handlers.clear();
  ho.invoke.mockClear();
  ho.responseCb = null;
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
  process.argv = ORIG_ARGV.slice();
});

// ---------- 脚手架 ----------

/** 冲刷微任务（readyPromise.then 推进 phase 在微任务里） */
function flushMicrotasks() {
  let p = Promise.resolve();
  for (let i = 0; i < 5; i++) p = p.then(() => {});
  return p;
}

function acc(id, providerId) {
  return { id, providerId, partition: 'persist:' + providerId + ':' + id };
}

/**
 * 起一个子代理任务：注入 fake 依赖 -> runAgent（不等待）-> 返回 state 与窗口句柄。
 * 依赖 windowState.addWindow 让 runAgent 取到 state.win/state.view（提醒发送目标为 view，findTaskByWebContents 反查）。
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
  // 086 窗口双层结构：win=壳页面（shell-preload，无 subagent-reminder 监听）；
  // view=AI 页（bridge/entry.js，subagent-reminder 监听端在此）——提醒必须发 view 而非 win。
  const winWc = { tag: 'win', send: vi.fn(), isDestroyed: () => false };
  const viewWc = { tag: 'view', send: vi.fn(), isDestroyed: () => false };
  const win = { id: 900, webContents: winWc, isDestroyed: () => false, close: vi.fn(), on: () => {} };
  const view = { webContents: viewWc, isDestroyed: () => false };
  const store = { state: { selectedProjectDir: null } };

  subagent.injectSubagentDeps({
    createWindow: () => {
      windowState.addWindow(win, 'subagent-tmp', providerId, store, view, true);
      return win.id;
    },
    profileManager: pm,
  });

  const p = subagent.runAgent({
    parentWindowId: 1, agentName: 'a', task: 't', systemPrompt: 's',
    timeoutMs: opts.timeoutMs,
  });
  p.catch(() => {}); // 标记已处理，避免未处理拒绝（断言处再 assert.rejects）

  const state = subagent.findTaskByWebContents(viewWc);
  assert.ok(state, 'runAgent 应同步注册任务到 activeTasks');
  return { p, win, winWc, view, viewWc, store, state, pm };
}

/** 完成 observer-ready 握手 -> 断言进入 working */
function handshake(env) {
  assert.strictEqual(subagent.onSubagentReady(env.viewWc), true, '首次握手应命中 starting 任务');
  return flushMicrotasks().then(() => {
    assert.strictEqual(env.state.phase, 'working');
    assert.strictEqual(env.state.startingTimer, null, '握手后应清 startingTimer');
    return env;
  });
}

function reminderCalls(env, wc) {
  // 默认断言 AI 页（view）收到提醒；传 wc 可查壳页面（win）作反向校验
  const target = wc || env.viewWc;
  return target.send.mock.calls.filter((c) => c[0] === 'subagent-reminder');
}

// =====================================================================
// 1. 层1：总超时
// =====================================================================

describe('层1 总超时（120min，覆盖 starting + working）', () => {
  test('自定义 timeoutMs=5s：握手进入 working 后推进 5s -> reject /子代理执行超时/', () => {
    const env = startTask({ timeoutMs: 5000 });
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(5000))
      .then(() => assert.rejects(env.p, /子代理执行超时/))
      .then(() => { assert.strictEqual(env.state.phase, 'failed'); });
  });

  test('边界 timeoutMs=20ms：未握手也由层1先触发 -> reject /子代理执行超时/', () => {
    const env = startTask({ timeoutMs: 20 });
    return vi.advanceTimersByTimeAsync(20)
      .then(() => assert.rejects(env.p, /子代理执行超时/));
  });

  test('默认 120min：working 阶段持续活动（markActivity 保活）-> 恰在 120min 触发总超时', () => {
    const env = startTask();
    const CHUNK = 10 * MIN; // < 15min 静默看门狗，分块推进 + 每块末保活
    let chain = handshake(env);
    for (let i = 0; i < 12; i++) {
      chain = chain.then(() => vi.advanceTimersByTimeAsync(CHUNK));
      if (i < 11) {
        chain = chain.then(() => {
          assert.strictEqual(subagent.markActivity(env.state), true, 'working 阶段活动应被允许');
        });
      }
    }
    return chain
      .then(() => assert.rejects(env.p, /子代理执行超时/))
      .then(() => {
        assert.strictEqual(Math.round(DEFAULT_TIMEOUT_MS / CHUNK), 12, '分块数应与总超时一致');
        assert.strictEqual(env.state.phase, 'failed');
      });
  });
});

// =====================================================================
// 2. 层2：starting 握手兜底超时
// =====================================================================

describe('层2 starting 超时（60s 无 subagent-ready）', () => {
  test('59.999s 未到时任务仍在 starting；推进到 60s -> reject /子窗口启动超时/', () => {
    const env = startTask();
    return vi.advanceTimersByTimeAsync(STARTING_TIMEOUT_MS - 1)
      .then(() => {
        assert.ok(subagent.findTaskByWebContents(env.viewWc), '未到点任务不应被移除');
        assert.strictEqual(env.state.phase, 'starting');
      })
      .then(() => vi.advanceTimersByTimeAsync(1))
      .then(() => assert.rejects(env.p, /子窗口启动超时/))
      .then(() => { assert.strictEqual(env.state.phase, 'failed'); });
  });

  test('握手成功后 startingTimer 已清 -> 再推进 60s 不因层2失败', () => {
    const env = startTask();
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(STARTING_TIMEOUT_MS))
      .then(() => {
        assert.strictEqual(env.state.phase, 'working', '层2 不应再触发（计时器已清）');
        assert.ok(subagent.findTaskByWebContents(env.viewWc));
      });
  });
});

// =====================================================================
// 3. 握手（含 n-1 重复调用）
// =====================================================================

describe('observer-ready 握手', () => {
  test('首次握手 true -> starting->working，清 startingTimer', () => {
    const env = startTask();
    assert.strictEqual(env.state.phase, 'starting');
    assert.ok(env.state.startingTimer, 'starting 阶段应有层2 计时器');
    return handshake(env);
  });

  test('n-1：微任务 flush 前重复 onSubagentReady -> false（幂等守卫，不二次 resolve）', () => {
    const env = startTask();
    assert.strictEqual(subagent.onSubagentReady(env.viewWc), true);
    // phase 仍为 starting（微任务未 flush），但 readyResolve 已置 null
    assert.strictEqual(env.state.phase, 'starting');
    assert.strictEqual(subagent.onSubagentReady(env.viewWc), false, '重复 ready 应返回 false');
    return flushMicrotasks().then(() => { assert.strictEqual(env.state.phase, 'working'); });
  });

  test('非 starting 阶段（已 working）-> false', () => {
    const env = startTask();
    return handshake(env).then(() => {
      assert.strictEqual(subagent.onSubagentReady(env.viewWc), false);
    });
  });

  test('错误 sender -> false，且不影响任务状态', () => {
    const env = startTask();
    assert.strictEqual(subagent.onSubagentReady({ tag: 'unknown' }), false);
    assert.strictEqual(subagent.onSubagentReady(null), false);
    assert.strictEqual(env.state.phase, 'starting');
  });
});

// =====================================================================
// 4. 层3：空闲提醒
// =====================================================================

describe('层3 空闲提醒（180s x2，超限静默）', () => {
  test('working 后 180s -> 发 subagent-reminder 且计数 1；再 180s -> 计数 2；第三次静默', () => {
    const env = startTask();
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS))
      .then(() => {
        assert.strictEqual(env.state.idleReminderCount, 1);
        assert.strictEqual(reminderCalls(env).length, 1, '提醒应发到 AI 页 view');
        assert.strictEqual(reminderCalls(env, env.winWc).length, 0, '壳页面 win 不应收到提醒');
        assert.match(reminderCalls(env)[0][1].message, /系统提醒/);
        assert.match(reminderCalls(env)[0][1].message, /超过 3 分钟/);
      })
      .then(() => vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS))
      .then(() => {
        assert.strictEqual(env.state.idleReminderCount, 2);
        assert.strictEqual(reminderCalls(env).length, 2);
      })
      .then(() => vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS))
      .then(() => {
        assert.strictEqual(env.state.idleReminderCount, 2, '超限后不再计数');
        assert.strictEqual(reminderCalls(env).length, 2, '超限后不再发提醒（静默等总超时）');
        assert.strictEqual(env.state.phase, 'working');
      });
  });

  test('markActivity 恢复活跃 -> idleReminderCount 归零', () => {
    const env = startTask();
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS))
      .then(() => {
        assert.strictEqual(env.state.idleReminderCount, 1);
        assert.strictEqual(subagent.markActivity(env.state), true);
        assert.strictEqual(env.state.idleReminderCount, 0);
      });
  });

  test('GLM provider：180s 不触发，12min 才触发（阈值按 provider 放宽）', () => {
    const env = startTask({ providerId: 'glm' });
    assert.strictEqual(env.state.provider, 'glm');
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS))
      .then(() => {
        assert.strictEqual(env.state.idleReminderCount, 0, 'GLM 180s 不应触发');
        assert.strictEqual(reminderCalls(env).length, 0);
      })
      .then(() => vi.advanceTimersByTimeAsync(GLM_IDLE_TIMEOUT_MS - IDLE_TIMEOUT_MS))
      .then(() => {
        assert.strictEqual(env.state.idleReminderCount, 1, 'GLM 12min 应触发');
        assert.match(reminderCalls(env)[0][1].message, /超过 12 分钟/);
      });
  });
});

// =====================================================================
// 5. 层4：静默硬看门狗
// =====================================================================

describe('层4 静默硬看门狗（15min 无真实活动）', () => {
  test('working 后 15min 无活动 -> reject /任务静默超时/', () => {
    const env = startTask();
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS))
      .then(() => assert.rejects(env.p, /任务静默超时/))
      .then(() => { assert.strictEqual(env.state.phase, 'failed'); });
  });

  test('边界：markActivity 重置 silence -> 再推进 800s 仍未失败', () => {
    const env = startTask();
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(800000))
      .then(() => { assert.strictEqual(subagent.markActivity(env.state), true); })
      .then(() => vi.advanceTimersByTimeAsync(800000)) // 累计 1600s > 900s，若未重置早已失败
      .then(() => {
        assert.ok(subagent.findTaskByWebContents(env.viewWc), '任务应仍存活');
        assert.strictEqual(env.state.phase, 'working');
      });
  });

  test('边界：recordRound 重置 silence -> 再推进 800s 仍未失败', () => {
    const env = startTask();
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(800000))
      .then(() => { assert.strictEqual(subagent.recordRound(env.state), true); })
      .then(() => vi.advanceTimersByTimeAsync(800000))
      .then(() => {
        assert.strictEqual(env.state.phase, 'working');
        assert.strictEqual(env.state.interactionCount, 1);
      });
  });

  test('层3 空闲提醒不重置 silence：180s 提醒后仍需在 15min 整点失败', () => {
    const env = startTask();
    return handshake(env)
      .then(() => vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS)) // 触发 1 次空闲提醒
      .then(() => {
        assert.strictEqual(env.state.idleReminderCount, 1, '前置：空闲提醒已触发');
      })
      .then(() => vi.advanceTimersByTimeAsync(SILENCE_TIMEOUT_MS - IDLE_TIMEOUT_MS)) // 累计 900s
      .then(() => assert.rejects(env.p, /任务静默超时/));
  });
});

// =====================================================================
// 6. 层5：轮次硬顶
// =====================================================================

describe('层5 轮次硬顶（150 -> force_deliver）', () => {
  test('recordRound x149 允许；第 150 轮 -> false + phase=force_deliver + 发提醒', () => {
    const env = startTask();
    return handshake(env).then(() => {
      for (let i = 1; i <= MAX_INTERACTION_ROUNDS - 1; i++) {
        assert.strictEqual(subagent.recordRound(env.state), true, '第 ' + i + ' 轮应允许继续');
      }
      assert.strictEqual(env.state.interactionCount, MAX_INTERACTION_ROUNDS - 1);
      assert.strictEqual(env.state.phase, 'working');

      const before = reminderCalls(env).length;
      assert.strictEqual(subagent.recordRound(env.state), false, '达硬顶应返回 false');
      assert.strictEqual(env.state.interactionCount, MAX_INTERACTION_ROUNDS);
      assert.strictEqual(env.state.phase, 'force_deliver');
      assert.strictEqual(reminderCalls(env).length, before + 1, '达硬顶应发一条提醒');
      assert.match(reminderCalls(env).slice(-1)[0][1].message, /最大交互轮次/);
    });
  });

  test('force_deliver 后再 recordRound -> false 且不再计数、不再发提醒', () => {
    const env = startTask();
    return handshake(env).then(() => {
      for (let i = 0; i < MAX_INTERACTION_ROUNDS; i++) subagent.recordRound(env.state);
      assert.strictEqual(env.state.phase, 'force_deliver');
      const before = reminderCalls(env).length;

      assert.strictEqual(subagent.recordRound(env.state), false);
      assert.strictEqual(env.state.interactionCount, MAX_INTERACTION_ROUNDS, '进入 force_deliver 后不再计数');
      assert.strictEqual(reminderCalls(env).length, before, '不应重复发提醒');
    });
  });

  test('边界：recordRound(null) / markActivity(null) -> false（不抛错）', () => {
    assert.strictEqual(subagent.recordRound(null), false);
    assert.strictEqual(subagent.markActivity(null), false);
    assert.strictEqual(subagent.recordRound(undefined), false);
    assert.strictEqual(subagent.markActivity(undefined), false);
  });
});

// =====================================================================
// 7. markActivity 的 phase 判断
// =====================================================================

describe('markActivity phase 判断', () => {
  test('working -> true，重置 idle + silence 计时器', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const idleBefore = env.state.idleTimer;
      const silenceBefore = env.state.silenceTimer;

      assert.strictEqual(subagent.markActivity(env.state), true);
      assert.notStrictEqual(env.state.idleTimer, idleBefore, 'working 应重置 idle 计时器');
      assert.notStrictEqual(env.state.silenceTimer, silenceBefore, 'working 应重置 silence 计时器');
      assert.strictEqual(env.state.idleReminderCount, 0);
    });
  });

  test('force_deliver -> false，仅重置 silence（不清 idle 计数）', () => {
    const env = startTask();
    return handshake(env).then(() => {
      for (let i = 0; i < MAX_INTERACTION_ROUNDS; i++) subagent.recordRound(env.state);
      assert.strictEqual(env.state.phase, 'force_deliver');

      env.state.idleReminderCount = 7; // 人为置位，观察是否被清零
      const idleBefore = env.state.idleTimer;
      const silenceBefore = env.state.silenceTimer;

      assert.strictEqual(subagent.markActivity(env.state), false, 'force_deliver 应拦截工具执行');
      assert.strictEqual(env.state.idleReminderCount, 7, 'force_deliver 不清 idle 计数');
      assert.strictEqual(env.state.idleTimer, idleBefore, 'force_deliver 不重置 idle 计时器');
      assert.notStrictEqual(env.state.silenceTimer, silenceBefore, 'force_deliver 仍重置 silence');
    });
  });
});

// =====================================================================
// 8. handleCandidateResult（T2c：subagent_result 围栏=完成 / plain_text 仅记录）
// =====================================================================

describe('handleCandidateResult（候选结果处理）', () => {
  test('working 阶段 subagent_result -> {success,accepted,taskId} 且任务 resolve 文本', () => {
    const env = startTask();
    return handshake(env).then(() => {
      assert.ok(env.state.timer && env.state.idleTimer && env.state.silenceTimer);

      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: VALID_RESULT });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);
      assert.strictEqual(res.taskId, env.state.taskId);
      return env.p.then((text) => {
        assert.ok(text.startsWith(VALID_RESULT), 'resolve 文本应以原始文本为前缀: ' + text);
        assert.strictEqual(env.state.phase, 'completed');
        assert.strictEqual(env.state.timer, null);
        assert.strictEqual(env.state.startingTimer, null);
        assert.strictEqual(env.state.idleTimer, null);
        assert.strictEqual(env.state.silenceTimer, null);
      });
    });
  });

  test('异常：subagent_result 空文本 -> {success:false} error 含"空"', () => {
    const env = startTask();
    return handshake(env).then(() => {
      for (const bad of ['', '   ', null, undefined]) {
        const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: bad });
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.accepted, false);
        assert.match(res.error, /空/);
      }
      assert.strictEqual(env.state.phase, 'working', '空文本不应完成任务');
      assert.ok(subagent.findTaskByWebContents(env.viewWc));
    });
  });

  test('plain_text -> {success:true,accepted:true,handled:false}，任务不完成', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'plain_text', text: '随便一段纯文本' });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);
      assert.strictEqual(res.handled, false);
      assert.strictEqual(env.state.phase, 'working', 'plain_text 不应完成任务');
      assert.ok(subagent.findTaskByWebContents(env.viewWc), '任务应仍在注册表');
    });
  });

  test('异常：未知 sender -> {success:false,accepted:false}', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const res = subagent.handleCandidateResult({ tag: 'nope' }, { type: 'subagent_result', text: 'X' });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.match(res.error, /未匹配到子 Agent 任务/);
      assert.strictEqual(env.state.phase, 'working', '未知 sender 不影响既有任务');
    });
  });

  test('异常：starting 阶段拒绝（未握手）-> {success:false}', () => {
    const env = startTask();
    assert.strictEqual(env.state.phase, 'starting');
    const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: 'X' });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.accepted, false);
    assert.match(res.error, /不在可接收阶段/);
    assert.strictEqual(env.state.phase, 'starting');
  });

  test('异常：未知 type -> {success:false} error 含"未知"', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'bogus', text: 'X' });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.match(res.error, /未知 result type/);
      assert.strictEqual(env.state.phase, 'working');
    });
  });

  test('force_deliver 阶段放行：subagent_result 仍被接收并完成', () => {
    const env = startTask();
    return handshake(env).then(() => {
      for (let i = 0; i < MAX_INTERACTION_ROUNDS; i++) subagent.recordRound(env.state);
      assert.strictEqual(env.state.phase, 'force_deliver');

      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: VALID_RESULT });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);
      return env.p.then((text) => {
        assert.ok(text.startsWith(VALID_RESULT), 'resolve 文本应以原始文本为前缀: ' + text);
        assert.strictEqual(env.state.phase, 'completed');
      });
    });
  });

  test('边界：已 completed 后重复上报 -> 幂等（不重复 resolve、返回 success:false 未匹配）', () => {
    const env = startTask();
    return handshake(env).then(() => {
      subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: VALID_RESULT });
      return env.p.then((text) => {
        assert.ok(text.startsWith(VALID_RESULT), 'resolve 文本应以原始文本为前缀: ' + text);
        assert.doesNotThrow(() => {
          const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: 'B' });
          assert.strictEqual(res.success, false, '任务已移出注册表 -> 未匹配');
        });
      });
    });
  });

  test('边界：缺省 payload（无参）-> 按 plain_text 处理，不完成', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const res = subagent.handleCandidateResult(env.viewWc);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);
      assert.strictEqual(res.handled, false);
      assert.strictEqual(env.state.phase, 'working');
    });
  });
});

// =====================================================================
// 9. m-4：bridge 仅含工具块计轮
// =====================================================================

describe('bridge m-4：仅含工具块上报 subagent-round', () => {
  const FENCE = String.fromCharCode(96, 96, 96); // 三个反引号
  const TOOL_TEXT = FENCE + 'cuckoo\n' + 'awa' + 'it bash("echo hi")\n' + FENCE;

  function bridgeCfg(over) {
    return Object.assign({
      agentName: 'a', task: 't', systemPrompt: 's',
      tools: null, maxTurns: null, projectDir: null,
    }, over || {});
  }

  function loadBridge(cfg) {
    process.argv = ['node', 'x', '--cuckoo-subagent=' + encodeURIComponent(JSON.stringify(cfg))];
    return import('../../src/bridge/subagent.js').then((bridge) => {
      const got = bridge.initSubagentIfNeeded();
      assert.ok(got, '应解析出子代理配置');
      assert.strictEqual(typeof ho.responseCb, 'function', '应注册回复监听');
      ho.invoke.mockClear(); // 丢弃 init 阶段的 subagent-ready
      return bridge;
    });
  }

  test('纯文本回复 -> 上报 subagent-candidate-result(plain_text)，不上报 subagent-round', () => {
    return loadBridge(bridgeCfg()).then(() => {
      ho.responseCb('这是最终答复，没有任何工具块');
      const channels = ho.invoke.mock.calls.map((c) => c[0]);
      assert.deepStrictEqual(channels, ['subagent-candidate-result']);
      assert.strictEqual(ho.invoke.mock.calls[0][1].type, 'plain_text');
      assert.strictEqual(ho.invoke.mock.calls[0][1].text, '这是最终答复，没有任何工具块');
    });
  });

  test('含工具块的回复 -> 上报 subagent-round，不上报 candidate-result（未达 maxTurns）', () => {
    return loadBridge(bridgeCfg()).then(() => {
      ho.responseCb('说明文字\n\n' + TOOL_TEXT);
      const channels = ho.invoke.mock.calls.map((c) => c[0]);
      assert.deepStrictEqual(channels, ['subagent-round']);
    });
  });

  test('空/纯空白回复 -> 任何通道都不上报', () => {
    return loadBridge(bridgeCfg()).then(() => {
      ho.responseCb('   ');
      assert.strictEqual(ho.invoke.mock.calls.length, 0);
    });
  });

  test('达到 maxTurns 的含工具块轮次 -> 先 subagent-round 再 subagent-candidate-result(partial)', () => {
    return loadBridge(bridgeCfg({ maxTurns: 2 })).then(() => {
      ho.responseCb(TOOL_TEXT);
      ho.responseCb(TOOL_TEXT);
      const channels = ho.invoke.mock.calls.map((c) => c[0]);
      assert.deepStrictEqual(channels, ['subagent-round', 'subagent-round', 'subagent-candidate-result']);
      const last = ho.invoke.mock.calls[2][1];
      assert.strictEqual(last.type, 'subagent_result');
      assert.strictEqual(last.partial, true);
      assert.strictEqual(last.turns, 2);
    });
  });

  test('混合输出（工具块 + subagent_result 同现）-> 工具块优先，仅上报 subagent-round', () => {
    const MIX = '说明\n' + TOOL_TEXT + '\n' + FENCE + 'subagent_result\n最终结果\n' + FENCE;
    return loadBridge(bridgeCfg()).then(() => {
      ho.responseCb(MIX);
      const channels = ho.invoke.mock.calls.map((c) => c[0]);
      assert.deepStrictEqual(channels, ['subagent-round'], '工具块优先，不判完成');
    });
  });

  test('仅 subagent_result 围栏（无工具块）-> 上报 subagent-candidate-result(subagent_result)', () => {
    const ONLY_RESULT = '这是最终答复\n\n' + FENCE + 'subagent_result\n交付内容\n' + FENCE;
    return loadBridge(bridgeCfg()).then(() => {
      ho.responseCb(ONLY_RESULT);
      const channels = ho.invoke.mock.calls.map((c) => c[0]);
      assert.deepStrictEqual(channels, ['subagent-candidate-result']);
      const payload = ho.invoke.mock.calls[0][1];
      assert.strictEqual(payload.type, 'subagent_result');
      assert.strictEqual(payload.text, '交付内容');
    });
  });

  test('无 --cuckoo-subagent 参数 -> 不激活、不发 subagent-ready', () => {
    process.argv = ['node', 'x'];
    return import('../../src/bridge/subagent.js').then((bridge) => {
      assert.strictEqual(bridge.initSubagentIfNeeded(), null);
      assert.strictEqual(ho.invoke.mock.calls.length, 0);
    });
  });
});

// =====================================================================
// 10. 集成：src/app/ipc/subagent.ts 三个处理器
// =====================================================================

describe('IPC 集成（registerSubagentIpc）', () => {
  function registerIpc() {
    return import('../../src/app/ipc/subagent.js').then((ipc) => {
      ipc.registerSubagentIpc();
      assert.ok(ho.handlers.has('subagent-candidate-result'));
      assert.ok(ho.handlers.has('subagent-ready'));
      assert.ok(ho.handlers.has('subagent-round'));
    });
  }

  test('subagent-ready：命中 starting 任务 -> { success: true } 并推进 working', () => {
    const env = startTask();
    return registerIpc()
      .then(() => ho.handlers.get('subagent-ready')({ sender: env.viewWc }))
      .then((res) => {
        assert.deepStrictEqual(res, { success: true });
        return flushMicrotasks();
      })
      .then(() => { assert.strictEqual(env.state.phase, 'working'); });
  });

  test('subagent-ready：未知 sender -> { success: false }', () => {
    startTask();
    return registerIpc()
      .then(() => ho.handlers.get('subagent-ready')({ sender: { tag: 'nope' } }))
      .then((res) => { assert.deepStrictEqual(res, { success: false }); });
  });

  test('subagent-round：命中任务 -> recordRound 计数 +1 且 allowed=true', () => {
    const env = startTask();
    return handshake(env)
      .then(() => registerIpc())
      .then(() => ho.handlers.get('subagent-round')({ sender: env.viewWc }))
      .then((res) => {
        assert.deepStrictEqual(res, { success: true, allowed: true });
        assert.strictEqual(env.state.interactionCount, 1);
      });
  });

  test('subagent-round：未知 sender -> { success: false }', () => {
    startTask();
    return registerIpc()
      .then(() => ho.handlers.get('subagent-round')({ sender: { tag: 'nope' } }))
      .then((res) => { assert.deepStrictEqual(res, { success: false }); });
  });

  test('subagent-candidate-result：subagent_result 命中任务 -> 完成任务并 resolve 文本', () => {
    const env = startTask();
    return handshake(env)
      .then(() => registerIpc())
      .then(() => ho.handlers.get('subagent-candidate-result')({ sender: env.viewWc }, { type: 'subagent_result', text: VALID_RESULT }))
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.accepted, true);
        return env.p;
      })
      .then((text) => {
        assert.ok(text.startsWith(VALID_RESULT), 'resolve 文本应以原始文本为前缀: ' + text);
        assert.strictEqual(env.state.phase, 'completed');
      });
  });

  test('subagent-candidate-result：plain_text -> 记录但不完成', () => {
    const env = startTask();
    return handshake(env)
      .then(() => registerIpc())
      .then(() => ho.handlers.get('subagent-candidate-result')({ sender: env.viewWc }, { type: 'plain_text', text: 'hi' }))
      .then((res) => {
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.accepted, true);
        assert.strictEqual(res.handled, false);
        assert.strictEqual(env.state.phase, 'working');
      });
  });

  test('subagent-candidate-result：未知 sender -> { success:false }', () => {
    startTask();
    return registerIpc()
      .then(() => ho.handlers.get('subagent-candidate-result')({ sender: { tag: 'nope' } }, { type: 'subagent_result', text: 'X' }))
      .then((res) => {
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.accepted, false);
      });
  });
});

// 代码观察 1：src/app/subagent.ts L192-196 recordRound 在 force_deliver 阶段仍先 _resetSilenceTimer
//   再 return false。即进入 force_deliver 后，每来一轮「含工具块」的回复都会推迟层4 静默看门狗
//   （bridge m-4 下纯文本回复不上报，故仅含工具块的轮次如此）。设计上由层1 总超时（120min）兜底，
//   不会永久悬挂；但「止损级」的 15min 静默在该阶段实际失效。若属预期，建议在报告/契约中显式写明；
//   否则可考虑 force_deliver 后不再重置 silence。
// 代码观察 2（已消解）：_sendStallReminder 现判 state.view.webContents.isDestroyed()（086 双层窗口，
//   提醒须发 AI 页 view）；_failTask 判 win.isDestroyed() 且先置 state.win=null。二者守卫对象不同（view vs win），
//   非风格不一致，无需统一。
