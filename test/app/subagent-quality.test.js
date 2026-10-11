'use strict';
/**
 * T2d 子代理质量防线 —— 单元 / 集成测试
 *
 * 被测（src/app/subagent.ts）：
 *   - isTrivialResult            敷衍检测（长度 < 30 / 敷衍话术开头且 < 100 / 单句且 < 100）
 *   - checkResultAuthenticity    结果真实性校验（路径提取 + 存在性 + mtime < startedAt）
 *   - handlePlainText            纯文本停顿检测（策略 A 提醒 / 策略 B 仅记录 / 上限静默）
 *   - handleCandidateResult      敷衍追问流程 + 真实性 warning 附加
 *
 * 契约（docs/plans/T2d-质量防线-实现报告.md §三）：
 *   - 敷衍上限 TRIVIAL_SUPPLEMENT_MAX=2：supplementCount < 2 → 追问不 resolve；
 *     >= 2 且仍敷衍 → 接受最后一次 + warning
 *   - 真实性校验：4 条路径正则；无候选路径 → null；不阻塞 resolve
 *   - handlePlainText：hasToolActivity=true → 策略 B 仅记录；否则提醒，上限 STALL_REMINDER_MAX=2
 *   - 提醒发送目标 = state.view.webContents（086 双层窗口）
 *
 * 隔离：mock createRequire('electron')；activeTasks 为模块级状态 → 每用例 vi.resetModules() 后重载。
 */

import { test, describe, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'cuckoo-subagent-quality-test');

// ---------- 外部边界 mock ----------
const ho = vi.hoisted(() => {
  const handlers = new Map();
  const invoke = vi.fn(() => Promise.resolve({ success: true }));
  const electron = {
    app: { getPath: () => '' },
    ipcRenderer: { invoke },
    ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); } },
  };
  return { electron, handlers, invoke };
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

let subagent;    // src/app/subagent.js
let windowState; // src/app/window.js

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.resetModules();
  ho.handlers.clear();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  return Promise.all([
    import('../../src/app/subagent.js'),
    import('../../src/app/window.js'),
  ]).then(([s, w]) => { subagent = s; windowState = w; });
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// =====================================================================
// A. isTrivialResult（纯函数）
// =====================================================================

describe('isTrivialResult（敷衍检测）', () => {
  test('空文本 / 长度 < 30 -> true', () => {
    assert.strictEqual(subagent.isTrivialResult(''), true);
    assert.strictEqual(subagent.isTrivialResult(null), true);
    assert.strictEqual(subagent.isTrivialResult(undefined), true);
    assert.strictEqual(subagent.isTrivialResult('x'.repeat(29)), true);
  });

  test('敷衍话术开头且 < 100 -> true（含大小写 done）', () => {
    assert.strictEqual(subagent.isTrivialResult('我完成了这个任务'), true);
    assert.strictEqual(subagent.isTrivialResult('任务已完成'), true);
    assert.strictEqual(subagent.isTrivialResult('处理完毕'), true);
    assert.strictEqual(subagent.isTrivialResult('done: finished all tasks'), true);
  });

  test('单句且 < 100 -> true（无结论单句）', () => {
    assert.strictEqual(subagent.isTrivialResult('这是一段没有任何结论的单句文本'), true);
    // 边界：单句 99 字符 -> true（严格 < 100）
    assert.strictEqual(subagent.isTrivialResult('x'.repeat(99)), true);
  });

  test('边界：单句恰好 100 字符 -> false（< 100 严格）', () => {
    assert.strictEqual(subagent.isTrivialResult('x'.repeat(100)), false);
  });

  test('多句且含具体产出 -> false', () => {
    const text = '完成分析：检查了文件 A 与文件 B，发现两个逻辑问题。建议按方案修复并补充回归测试。';
    assert.strictEqual(subagent.isTrivialResult(text), false);
  });
});

// =====================================================================
// B. checkResultAuthenticity（真实文件系统）
// =====================================================================

describe('checkResultAuthenticity（结果真实性校验）', () => {
  test('无声称路径 -> null', () => {
    const state = { startedAt: Date.now(), projectDir: TMP };
    assert.strictEqual(subagent.checkResultAuthenticity(state, '这段文本没有任何文件路径。'), null);
  });

  test('声称存在且 mtime > startedAt 的文件 -> null', () => {
    const rel = 'sub/present.txt';
    const abs = path.join(TMP, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'hi');
    const state = { startedAt: 0, projectDir: TMP };
    assert.strictEqual(subagent.checkResultAuthenticity(state, '已分析 sub/present.txt 内容'), null);
  });

  test('声称不存在的文件 -> warning 含"声称的文件未找到"', () => {
    const state = { startedAt: Date.now(), projectDir: TMP };
    const w = subagent.checkResultAuthenticity(state, '已修改 sub/missing.txt 文件');
    assert.ok(w && w.includes('声称的文件未找到'), '应给出未找到 warning: ' + w);
  });

  test('文件存在但 mtime 早于 startedAt -> warning 含"修改时间早于任务开始"', () => {
    const rel = 'sub/old.txt';
    const abs = path.join(TMP, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'old');
    const old = new Date(Date.now() - 100000);
    fs.utimesSync(abs, old, old);
    const state = { startedAt: Date.now(), projectDir: TMP };
    const w = subagent.checkResultAuthenticity(state, '已完成 sub/old.txt 修改');
    assert.ok(w && w.includes('修改时间早于任务开始'), '应给出旧文件 warning: ' + w);
  });

  test('多路径混合 -> warning 拼接', () => {
    const state = { startedAt: Date.now(), projectDir: TMP };
    const w = subagent.checkResultAuthenticity(state, '已改 sub/a.txt 和 sub/b.txt 两文件');
    assert.ok(w && w.includes('sub/a.txt') && w.includes('sub/b.txt'), 'warning 应含两路径: ' + w);
  });
});

// =====================================================================
// C. handlePlainText（停住检测，纯 state 驱动）
// =====================================================================

function plainState(over) {
  return Object.assign({
    taskId: 't-plain',
    hasToolActivity: false,
    stallReminderCount: 0,
    view: { webContents: { isDestroyed: () => false, send: vi.fn() } },
  }, over || {});
}

function reminderCalls(state) {
  return state.view.webContents.send.mock.calls.filter((c) => c[0] === 'subagent-reminder');
}

describe('handlePlainText（纯文本停顿检测）', () => {
  test('hasToolActivity=true -> 策略 B 仅记录，不发提醒、不递增', () => {
    const state = plainState({ hasToolActivity: true });
    subagent.handlePlainText(state, '有工具活动的纯文本');
    assert.strictEqual(state.stallReminderCount, 0);
    assert.strictEqual(reminderCalls(state).length, 0);
  });

  test('hasToolActivity=false, count 0 -> 发提醒，count=1', () => {
    const state = plainState();
    subagent.handlePlainText(state, '停顿文本');
    assert.strictEqual(state.stallReminderCount, 1);
    assert.strictEqual(reminderCalls(state).length, 1);
    assert.match(reminderCalls(state)[0][1].message, /请继续执行任务/);
  });

  test('count=1 -> 再发提醒，count=2', () => {
    const state = plainState({ stallReminderCount: 1 });
    subagent.handlePlainText(state, '停顿文本');
    assert.strictEqual(state.stallReminderCount, 2);
    assert.strictEqual(reminderCalls(state).length, 1);
  });

  test('count>=2 -> 静默，不递增、不发提醒', () => {
    const state = plainState({ stallReminderCount: 2 });
    subagent.handlePlainText(state, '停顿文本');
    assert.strictEqual(state.stallReminderCount, 2);
    assert.strictEqual(reminderCalls(state).length, 0);
  });

  test('view 已销毁 -> 不抛错', () => {
    const state = plainState();
    state.view.webContents.isDestroyed = () => true;
    assert.doesNotThrow(() => subagent.handlePlainText(state, '停顿文本'));
    assert.strictEqual(state.stallReminderCount, 1, '计数仍在发送前递增');
    assert.strictEqual(reminderCalls(state).length, 0);
  });
});

// =====================================================================
// D. handleCandidateResult 敷衍追问流程（集成，经 runAgent 注册任务）
// =====================================================================

const VALID_RESULT = '检查完成：已阅读三个源文件，定位到两处逻辑缺陷。建议按修复方案 A 与 B 处理，并补充回归测试。';

function acc(id, providerId) {
  return { id, providerId, partition: 'persist:' + providerId + ':' + id };
}

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
  const winWc = { tag: 'win', send: vi.fn(), isDestroyed: () => false };
  const viewWc = { tag: 'view', send: vi.fn(), isDestroyed: () => false };
  const win = { id: 900, webContents: winWc, isDestroyed: () => false, close: vi.fn(), on: () => {} };
  const view = { webContents: viewWc, isDestroyed: () => false };
  const store = { state: { selectedProjectDir: TMP } };

  subagent.injectSubagentDeps({
    createWindow: () => {
      windowState.addWindow(win, 'subagent-tmp', providerId, store, view, true);
      return win.id;
    },
    profileManager: pm,
  });

  const p = subagent.runAgent({ parentWindowId: 1, agentName: 'a', task: 't', systemPrompt: 's' });
  p.catch(() => {});
  const state = subagent.findTaskByWebContents(viewWc);
  assert.ok(state, 'runAgent 应同步注册任务');
  return { p, win, winWc, view, viewWc, store, state, pm };
}

function flushMicrotasks() {
  let p = Promise.resolve();
  for (let i = 0; i < 5; i++) p = p.then(() => {});
  return p;
}

function handshake(env) {
  assert.strictEqual(subagent.onSubagentReady(env.viewWc), true);
  return flushMicrotasks().then(() => {
    assert.strictEqual(env.state.phase, 'working');
    return env;
  });
}

const TRIVIAL = '已完成';

describe('handleCandidateResult 敷衍追问流程', () => {
  test('敷衍文本 + supplementCount=0 -> 追问不 resolve，count=1，view 收到 subagent-reminder', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: TRIVIAL });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);
      assert.strictEqual(res.handled, false);
      assert.strictEqual(env.state.supplementCount, 1, '追问计数应 +1');
      assert.strictEqual(env.state.phase, 'working', '敷衍不应完成任务');
      assert.ok(subagent.findTaskByWebContents(env.viewWc), '任务应仍在注册表');
      const reminders = env.viewWc.send.mock.calls.filter((c) => c[0] === 'subagent-reminder');
      assert.strictEqual(reminders.length, 1, '应发一条追问提醒到 view');
      assert.match(reminders[0][1].message, /过于简单/);
    });
  });

  test('敷衍第 2 次（count=1）-> 追问不 resolve，count=2', () => {
    const env = startTask();
    return handshake(env).then(() => {
      subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: TRIVIAL });
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: TRIVIAL });
      assert.strictEqual(res.handled, false);
      assert.strictEqual(env.state.supplementCount, 2);
      assert.strictEqual(env.state.phase, 'working');
    });
  });

  test('敷衍超限（count>=2）-> 接受 + resolve + warning 含"敷衍"/"连续"', () => {
    const env = startTask();
    return handshake(env).then(() => {
      env.state.supplementCount = 2;
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: TRIVIAL });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);
      assert.strictEqual(res.taskId, env.state.taskId);
      assert.ok(res.warning && res.warning.includes('连续') && res.warning.includes('敷衍'), 'warning: ' + res.warning);
      return env.p.then((text) => {
        assert.ok(text.startsWith(TRIVIAL), 'resolve 文本应以原始文本为前缀: ' + text);
        assert.ok(text.includes('\n\n[质量警示] '), 'resolve 文本尾部应含质量警示: ' + text);
        assert.ok(text.includes(res.warning), '质量警示内容应与 res.warning 一致');
        assert.strictEqual(env.state.phase, 'completed');
      });
    });
  });

  test('非敷衍文本 -> 直接完成；真实性 warning 附到返回结果', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const text = VALID_RESULT + ' 已修改 sub/missing.txt 文件';
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);
      assert.ok(res.warning && res.warning.includes('真实性校验') && res.warning.includes('声称的文件未找到'), 'warning: ' + res.warning);
      return env.p.then((t) => {
        assert.ok(t.startsWith(text), 'resolve 文本应以原始文本为前缀: ' + t);
        assert.ok(t.includes('\n\n[质量警示] '), 'resolve 文本尾部应含质量警示: ' + t);
        assert.ok(t.includes(res.warning), '质量警示内容应与 res.warning 一致');
        assert.strictEqual(env.state.phase, 'completed');
      });
    });
  });

  test('非敷衍文本且无路径 -> 直接完成，无 warning', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: VALID_RESULT });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);
      assert.strictEqual(res.warning, undefined);
      return env.p.then((t) => { assert.ok(t.startsWith(VALID_RESULT), 'resolve 文本应以原始文本为前缀: ' + t); });
    });
  });

  test('force_deliver 阶段敷衍 -> 追问路径同样生效（不 resolve）', () => {
    const env = startTask();
    return handshake(env).then(() => {
      for (let i = 0; i < 150; i++) subagent.recordRound(env.state);
      assert.strictEqual(env.state.phase, 'force_deliver');
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: TRIVIAL });
      assert.strictEqual(res.handled, false);
      assert.strictEqual(env.state.supplementCount, 1);
      assert.strictEqual(env.state.phase, 'force_deliver', '敷衍时不应完成');
    });
  });
});
