'use strict';
/**
 * T2 子代理副账号池 单元测试（M-3）
 *
 * 被测：
 *   - src/app/subagent.ts  getSubagentAccount（私有，经 runAgent 暴露）+ runAgent 派发/超时/清理
 *   - src/app/profile.ts   createSubagentProfile（复用池账号 partition + 独立子代理 profile）
 *
 * 契约（docs/plans/subagent-port-spec.md AC-1 + §九决策3；docs/reviews/T2-rereview.md §1.1）：
 *   - 主账号 = getLastActiveProfileId() 命中的 profile；无记录/记录失效 → 回退 profiles[0]
 *   - 池 = profiles.filter(p => p.id !== mainId && p.autoOpen !== true)；池空 → 抛错，不借主账号
 *     （autoOpen=true 是用户指定「启动即开窗」的常驻账号，隔离出池，避免与常驻窗口抢 partition）
 *   - 游标按派发顺序在池内轮转（_poolCursor 模块级，resetModules 后归零）
 *
 * 隔离：mock createRequire('electron') 指向临时 userData（外部边界）；subagent.ts 本身
 * 只依赖 ./window.js（不加载 Electron），runAgent 由注入的 fake createWindow/profileManager 驱动。
 * 注：本文件用 promise 链（.then/.finally）替代 async/await，行为等价。
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const TMP = path.join(os.tmpdir(), 'cuckoo-subagent-pool-test');
const USER_DATA = path.join(TMP, 'userdata');

vi.mock('node:module', (importOriginal) =>
  importOriginal().then((actual) => ({
    ...actual,
    createRequire: () => (id) => {
      if (id === 'electron') return { app: { getPath: () => USER_DATA } };
      throw new Error('unexpected require: ' + id);
    },
  })),
);

let subagent;   // src/app/subagent.js
let profile;    // src/app/profile.js
let windowState;

beforeEach(() => {
  vi.resetModules();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  return Promise.all([
    import('../../src/app/subagent.js'),
    import('../../src/app/window.js'),
    import('../../src/app/profile.js'),
  ]).then(([s, w, p]) => {
    subagent = s;
    windowState = w;
    profile = p;
  });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- 测试脚手架 ----------

/** 造一个记录选号结果的 fake profileManager */
function makeProfileManager(profiles, lastActiveId, opts = {}) {
  const picked = [];
  const pm = {
    _picked: picked,
    readProfiles: () => (opts.rawProfiles !== undefined ? opts.rawProfiles : profiles),
    createSubagentProfile: (account, agentName) => {
      picked.push({ account, agentName });
      return {
        id: 'subagent-fake-' + picked.length,
        providerId: account.providerId,
        name: '子代理: ' + (agentName || 'agent'),
        partition: account.partition,
        isSubagent: true,
      };
    },
  };
  // opts.noLastActive：模拟 DI 缺少该方法（subagent.ts L37-39 的存在性守卫）
  if (!opts.noLastActive) {
    pm.getLastActiveProfileId = () => lastActiveId;
  }
  return pm;
}

/**
 * 造一个 fake 子代理窗口：注册到 windowState（让 runAgent 取到 state.win/state.view），
 * 并返回 { id, viewWc }（viewWc 用于经 handleCandidateResult 反查 sender，T2c）。
 */
function makeSubWindow(id, sp) {
  const viewWc = { tag: 'view-' + id, isDestroyed: () => false };
  const winWc = { tag: 'win-' + id, isDestroyed: () => false, send() {} };
  const win = { id, webContents: winWc, on() {}, isDestroyed: () => false, close() {} };
  const view = { webContents: viewWc, isDestroyed: () => false };
  const store = { state: { selectedProjectDir: null } };
  windowState.addWindow(win, sp.id, sp.providerId, store, view, true);
  return { id, viewWc, win, view, store };
}

/**
 * 完成一次 observer-ready 握手（starting->working，微任务中推进）后上报候选结果。
 * T2c：handleCandidateResult 仅接受 working / force_deliver 阶段，必须先握手。
 */
function handshakeThenCandidate(viewWc, text) {
  subagent.onSubagentReady(viewWc);
  let p = Promise.resolve();
  for (let i = 0; i < 5; i++) p = p.then(() => {});
  return p.then(() => subagent.handleCandidateResult(viewWc, { type: 'subagent_result', text }));
}

/** 一次性派发：注入 fake 依赖 → 跑 runAgent → resolve { text, pm } */
function dispatch(profiles, lastActiveId, opts = {}) {
  const pm = makeProfileManager(profiles, lastActiveId, opts);
  let nextId = 9000;
  const createWindow = (sp) => {
    const id = nextId++;
    const { viewWc } = makeSubWindow(id, sp);
    setTimeout(() => {
      const text = opts.text !== undefined ? opts.text : VALID_RESULT;
      handshakeThenCandidate(viewWc, text);
    }, 0);
    return id;
  };
  subagent.injectSubagentDeps({ createWindow, profileManager: pm });
  return subagent
    .runAgent({
      parentWindowId: 1,
      agentName: opts.agentName || 'tester',
      task: 'do-something',
      systemPrompt: 'sys',
      timeoutMs: opts.timeoutMs,
    })
    .then((text) => ({ text, pm }));
}

/** 注入 fake 依赖并返回 pm（供断言 reject 的用例复用） */
function inject(profiles, lastActiveId, opts = {}) {
  const pm = makeProfileManager(profiles, lastActiveId, opts);
  subagent.injectSubagentDeps({ createWindow: () => 1, profileManager: pm });
  return pm;
}

const runOpts = { parentWindowId: 1, agentName: 'a', task: 't', systemPrompt: 's' };
const acc = (id, providerId = 'deepseek') => ({
  id,
  providerId,
  partition: 'persist:' + providerId + ':' + id,
});

// T2d：非敷衍的有效结果文本（>=30 字符、非敷衍话术开头、多句）。
// 短占位文本（'RESULT'/'r'/'OK'/'DONE'）会被 isTrivialResult 判为敷衍 → 追问不 resolve，故统一替换。
const VALID_RESULT = '检查完成：已阅读三个源文件，定位到两处逻辑缺陷。建议按修复方案 A 与 B 处理，并补充回归测试。';

// ================= 1. 池空：仅主账号 → 报错 =================

test('池空-仅主账号时报错（last-active 命中该账号）', () => {
  const pm = inject([acc('main')], 'main');
  return assert.rejects(() => subagent.runAgent(runOpts), /副账号池为空/).then(() => {
    assert.strictEqual(pm._picked.length, 0, '池空时不得创建子代理 profile');
  });
});

test('池空-仅主账号时报错（无 last-active，回退首位）', () => {
  inject([acc('main')], null);
  return assert.rejects(() => subagent.runAgent(runOpts), /副账号池为空/);
});

// ================= 2. 池空：空列表 → 报错 =================

test('池空-空列表时报错', () => {
  inject([], null);
  return assert.rejects(() => subagent.runAgent(runOpts), /副账号池为空/);
});

test('池空-readProfiles 返回非数组时按空列表处理', () => {
  inject(null, null, { rawProfiles: null });
  return assert.rejects(() => subagent.runAgent(runOpts), /副账号池为空/);
});

// ================= 3. 轮转：池内游标回绕 =================

test('轮转-池3账号连续4次派发回绕为 [a,b,c,a]', () => {
  const pm = makeProfileManager([acc('main'), acc('a'), acc('b'), acc('c')], 'main');
  let nextId = 9000;
  subagent.injectSubagentDeps({
    createWindow: (sp) => {
      const id = nextId++;
      const { viewWc } = makeSubWindow(id, sp);
      setTimeout(() => handshakeThenCandidate(viewWc, VALID_RESULT), 0);
      return id;
    },
    profileManager: pm,
  });
  let chain = Promise.resolve();
  for (let i = 0; i < 4; i++) {
    chain = chain
      .then(() => subagent.runAgent(runOpts))
      .then((text) => {
        assert.ok(text.startsWith(VALID_RESULT), 'resolve 文本应以原始文本为前缀: ' + text);
      });
  }
  return chain.then(() => {
    assert.deepStrictEqual(pm._picked.map((x) => x.account.id), ['a', 'b', 'c', 'a']);
  });
});

test('轮转-池2账号连续3次派发回绕为 [a,b,a]', () => {
  const pm = makeProfileManager([acc('main'), acc('a'), acc('b')], 'main');
  let nextId = 100;
  subagent.injectSubagentDeps({
    createWindow: (sp) => {
      const id = nextId++;
      const { viewWc } = makeSubWindow(id, sp);
      setTimeout(() => handshakeThenCandidate(viewWc, VALID_RESULT), 0);
      return id;
    },
    profileManager: pm,
  });
  let chain = Promise.resolve();
  for (let i = 0; i < 3; i++) {
    chain = chain.then(() => subagent.runAgent(runOpts));
  }
  return chain.then(() => {
    assert.deepStrictEqual(pm._picked.map((x) => x.account.id), ['a', 'b', 'a']);
  });
});

// ================= 4. 主账号判据：真实主账号不入池 =================

test('主账号判据-删除首位后真实主账号不入池（last-active 命中下标1）', () => {
  return dispatch([acc('sub1'), acc('main')], 'main').then(({ pm }) => {
    assert.deepStrictEqual(pm._picked.map((x) => x.account.id), ['sub1']);
  });
});

test('主账号判据-主账号在末位时池仍取其余账号', () => {
  return dispatch([acc('sub1'), acc('sub2'), acc('main')], 'main').then(({ pm }) => {
    assert.strictEqual(pm._picked[0].account.id, 'sub1');
    assert.ok(pm._picked.every((x) => x.account.id !== 'main'), '主账号不得入池');
  });
});

// ================= 5. 主账号判据：无/失效 last-active 回退首位 =================

test('主账号判据-无 last-active 时回退首位', () => {
  return dispatch([acc('main'), acc('sub1'), acc('sub2')], null).then(({ pm }) => {
    assert.strictEqual(pm._picked[0].account.id, 'sub1');
    assert.ok(pm._picked.every((x) => x.account.id !== 'main'));
  });
});

test('主账号判据-last-active 指向已删除 id 时回退首位', () => {
  return dispatch([acc('main'), acc('sub1')], 'profile-deleted-xyz').then(({ pm }) => {
    assert.deepStrictEqual(pm._picked.map((x) => x.account.id), ['sub1']);
  });
});

test('主账号判据-DI 缺少 getLastActiveProfileId 时回退首位', () => {
  return dispatch([acc('main'), acc('sub1')], null, { noLastActive: true }).then(({ pm }) => {
    assert.deepStrictEqual(pm._picked.map((x) => x.account.id), ['sub1']);
  });
});

// ================= 6. 日志脱敏 =================

test('日志脱敏-runAgent 不将 account.name 写入日志', () => {
  const sensitive = 'user-13800000000@example.com';
  const main = { id: 'main', name: sensitive, providerId: 'deepseek', partition: 'persist:deepseek:main' };
  const sub = { id: 'sub1', name: sensitive + '-2', providerId: 'glm', partition: 'persist:glm:sub1' };
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return dispatch([main, sub], 'main')
    .then(() => {
      const logs = spy.mock.calls.map((c) => c.map(String).join(' ')).join(' | ');
      assert.ok(!logs.includes(sensitive), '日志不得包含 account.name（可能含手机号/邮箱）');
      assert.ok(logs.includes('sub1'), '日志应打印 account.id 以便排障');
    })
    .finally(() => spy.mockRestore());
});

// ================= 7. runAgent 派发 / 超时 / 清理 =================

test('runAgent-未注入依赖时抛错', () => {
  return assert.rejects(() => subagent.runAgent(runOpts), /子代理依赖未注入/);
});

test('runAgent-超时返回错误（永不回调窗口）', () => {
  inject([acc('main'), acc('sub1')], 'main');
  subagent.injectSubagentDeps({ createWindow: () => 700, profileManager: makeProfileManager([acc('main'), acc('sub1')], 'main') });
  return assert.rejects(
    () => subagent.runAgent({ ...runOpts, timeoutMs: 20 }),
    /子代理执行超时/,
  );
});

test('runAgent-复用父窗口项目目录写入子代理 sessionStore 并关闭子窗口', () => {
  const parentStore = { state: { selectedProjectDir: 'E:/proj-x' } };
  const parentWin = { id: 500, on() {}, isDestroyed: () => false, close() {}, webContents: {} };
  windowState.addWindow(parentWin, 'p-main', 'deepseek', parentStore, {});

  const pm = makeProfileManager([acc('main'), acc('sub1')], 'main');
  const subStore = { state: { selectedProjectDir: null } };
  let closed = false;
  const subWin = { id: 501, on() {}, isDestroyed: () => false, close() { closed = true; }, webContents: {} };
  const subViewWc = { tag: 'view-501', isDestroyed: () => false };
  const subView = { webContents: subViewWc, isDestroyed: () => false };
  subagent.injectSubagentDeps({
    createWindow: (sp) => {
      windowState.addWindow(subWin, sp.id, sp.providerId, subStore, subView, true);
      setTimeout(() => handshakeThenCandidate(subViewWc, VALID_RESULT), 0);
      return subWin.id;
    },
    profileManager: pm,
  });
  return subagent
    .runAgent({ parentWindowId: 500, agentName: 'a', task: 't', systemPrompt: 's' })
    .then((text) => {
      assert.ok(text.startsWith(VALID_RESULT), 'resolve 文本应以原始文本为前缀: ' + text);
      assert.strictEqual(subStore.state.selectedProjectDir, 'E:/proj-x');
      assert.strictEqual(closed, true, '子代理窗口应在 finally 中关闭');
    });
});

test('handleCandidateResult-未知 sender 不抛错且返回 success:false', () => {
  assert.doesNotThrow(() => {
    const res = subagent.handleCandidateResult({ tag: 'nope' }, { type: 'subagent_result', text: 'x' });
    assert.strictEqual(res.success, false);
  });
});

test('handleCandidateResult-空 subagent_result 文本被拒绝，任务不完成（随后有效文本完成）', () => {
  const pm = makeProfileManager([acc('main'), acc('sub1')], 'main');
  let nextId = 300;
  subagent.injectSubagentDeps({
    createWindow: (sp) => {
      const id = nextId++;
      const { viewWc } = makeSubWindow(id, sp);
      setTimeout(() => {
        subagent.onSubagentReady(viewWc);
        let p = Promise.resolve();
        for (let i = 0; i < 5; i++) p = p.then(() => {});
        p.then(() => {
          // 先上报空文本 -> 应被拒绝、任务仍在
          const bad = subagent.handleCandidateResult(viewWc, { type: 'subagent_result', text: '   ' });
          assert.strictEqual(bad.success, false);
          assert.match(bad.error, /空/);
          assert.ok(subagent.findTaskByWebContents(viewWc), '空文本后任务应仍在注册表');
          // 再用有效文本完成
          subagent.handleCandidateResult(viewWc, { type: 'subagent_result', text: VALID_RESULT });
        });
      }, 0);
      return id;
    },
    profileManager: pm,
  });
  return subagent.runAgent(runOpts).then((text) => {
    assert.ok(text.startsWith(VALID_RESULT), 'resolve 文本应以原始文本为前缀: ' + text);
  });
});

// ================= 7.5 autoOpen 账号隔离 =================

test('autoOpen 隔离-轮转只含非 autoOpen 副账号，跳过 autoOpen 账号', () => {
  const profiles = [
    { id: 'main', providerId: 'deepseek', partition: 'p:main', autoOpen: false },
    { id: 'a', providerId: 'deepseek', partition: 'p:a', autoOpen: true },
    { id: 'b', providerId: 'deepseek', partition: 'p:b', autoOpen: false },
    { id: 'c', providerId: 'deepseek', partition: 'p:c', autoOpen: false },
  ];
  const pm = makeProfileManager(profiles, 'main');
  let nextId = 500;
  subagent.injectSubagentDeps({
    createWindow: (sp) => {
      const id = nextId++;
      const { viewWc } = makeSubWindow(id, sp);
      setTimeout(() => handshakeThenCandidate(viewWc, VALID_RESULT), 0);
      return id;
    },
    profileManager: pm,
  });
  let chain = Promise.resolve();
  for (let i = 0; i < 3; i++) {
    chain = chain.then(() => subagent.runAgent(runOpts));
  }
  return chain.then(() => {
    assert.deepStrictEqual(pm._picked.map((x) => x.account.id), ['b', 'c', 'b']);
  });
});

test('autoOpen 隔离-仅剩 autoOpen 账号时报池空', () => {
  const profiles = [
    { id: 'main', providerId: 'deepseek', partition: 'p:main', autoOpen: false },
    { id: 'gpt', providerId: 'chatgpt', partition: 'p:gpt', autoOpen: true },
  ];
  const pm = inject(profiles, 'main');
  return assert.rejects(() => subagent.runAgent(runOpts), /副账号池为空/).then(() => {
    assert.strictEqual(pm._picked.length, 0, '池空时不得创建子代理 profile');
  });
});

// ================= 8. createSubagentProfile（profile.ts） =================

test('createSubagentProfile-复用池账号 partition（独立于主账号，AC-1）', () => {
  const main = acc('main', 'deepseek');
  const sub = acc('sub1', 'glm');
  const sp = profile.createSubagentProfile(sub, 'reviewer');
  assert.strictEqual(sp.partition, sub.partition);
  assert.notStrictEqual(sp.partition, main.partition);
  assert.strictEqual(sp.providerId, 'glm');
  assert.strictEqual(sp.isSubagent, true);
  assert.ok(sp.id.startsWith('subagent-'));
  assert.ok(sp.name.includes('reviewer'));
});

test('createSubagentProfile-生成的 profile 不写入 profile-list.json', () => {
  profile.createProfile('主账号', 'deepseek');
  const before = profile.readProfiles().length;
  const sp = profile.createSubagentProfile(acc('sub1', 'deepseek'), 'a');
  const after = profile.readProfiles();
  assert.strictEqual(after.length, before);
  assert.ok(!after.some((p) => p.id === sp.id), '子代理 profile 不应落盘到 profile-list');
});

test('createSubagentProfile-相同池账号多次派发共享同一 partition', () => {
  const sub = acc('sub1', 'deepseek');
  const sp1 = profile.createSubagentProfile(sub, 'a');
  const sp2 = profile.createSubagentProfile(sub, 'b');
  assert.strictEqual(sp1.partition, sp2.partition);
  assert.notStrictEqual(sp1.id, sp2.id, '每次派发生成独立临时 profile id');
});

// 代码观察：src/app/profile.ts L162-171 createSubagentProfile 对 account 为 null 无判空，
// 会抛 "TypeError: Cannot read properties of null (reading 'providerId')"（首轮评审 m-6，未修）。
// 本测试未断言该行为以免固化错误信息；建议后续入口判空并抛带语义的错误。
