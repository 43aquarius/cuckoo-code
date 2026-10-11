'use strict';
/**
 * T2g 子代理结果落盘 + 7 天清理 —— 单元 / 集成测试
 *
 * 被测：src/app/subagent.ts
 *   - handleCandidateResult 落盘段（L799-812）：写 {projectDir|process.cwd()}/.cuckoo/subagent-results/{taskId}.md，
 *     失败返回 {success:false, accepted:false, error:'落盘失败: ...'} 且不 resolve（不调 _completeTask）。
 *   - _completeTask（L559-580）拼接顺序：正文 → "\n\n[完整报告] <path>" → "\n\n[质量警示] <warning>"。
 *   - _cleanupDir（L587-607）/ _cleanupOldResults（L614-618）：删 > 7 天文件、目录不存在静默、
 *     单条失败不中断；subagent-results + subagent-tools 两目录各清一次。
 *
 * 契约（docs/plans/T2g-结果落盘与清理-实现报告.md §三；docs/reviews/T2g-review.md M-5）：
 *   - 落盘路径 {projectDir|process.cwd()}/.cuckoo/subagent-results/{taskId}.md，内容 = 原始 text（非拼好的 out）。
 *   - 落盘失败 → return error 不 resolve（任务留注册表，交层1/层4 超时兜底）。
 *   - RESULTS_CLEANUP_MAX_AGE_MS = 7 天；判据 now - mtimeMs > MAX（严格大于）。
 *   - _cleanupOldResults(projectDir)：projectDir 为空直接 return；否则对
 *     subagent-results + subagent-tools 各调一次 _cleanupDir。
 *   - _cleanupDir/_cleanupOldResults 未导出 —— 经 runAgent 委派时同步触发（L851），以文件存在性间接断言。
 *
 * 隔离：mock createRequire('electron')（外部边界，防意外 require）；
 *   mock node:fs 的 unlinkSync（仅用于 #10 注入 unlink 失败，其余调用透传真实 fs）。
 *   activeTasks / _taskSeq 为模块级状态 → 每用例 vi.resetModules() 后重新 import。
 *   落盘 / 清理均用真实 fs + os.tmpdir() 子目录（TMP），afterEach 清理。
 *
 * 自检（变更点 → 用例 → 触发逻辑 → 覆盖场景）：
 *   1 落盘成功            → handleCandidateResult 写 TMP/.cuckoo/.../{taskId}.md            正常
 *   2 落盘失败            → resultsDir 被同名文件占位 → mkdirSync 失败                     异常
 *   3 projectDir=null 回落 → process.cwd()/.cuckoo/.../{taskId}.md                          边界
 *   4 resolve = 正文+报告 → 无 warning 路径，精确相等                                      正常
 *   5 resolve 顺序        → 敷衍超限 warning → 正文→报告→警示                              正常
 *   6 清理 > 7 天         → mtime = now-8d → runAgent 触发 cleanup → 文件消失               正常
 *   7 保留 < 7 天（含边界）→ mtime = now-1d / now-(7d-10s) → 保留                           边界
 *   8 目录不存在          → .cuckoo 不存在 → runAgent 不抛、不产生清理失败 warn            异常
 *   9 两目录各清一次      → results + tools 各放过期文件 → 均删                             正常
 *  10 unlink 失败不中断   → mock unlinkSync 对指定路径抛 EACCES → 两次 warn，循环继续      异常
 */

import { test, describe, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'cuckoo-subagent-result-test');

// ---------- 外部边界 mock（vi.hoisted，避免工厂引用未初始化变量）----------

const ho = vi.hoisted(() => {
  const handlers = new Map();
  const invoke = vi.fn(() => Promise.resolve({ success: true }));
  const electron = {
    app: { getPath: () => '' },
    ipcRenderer: { invoke },
    ipcMain: { handle: (ch, fn) => { handlers.set(ch, fn); } },
  };
  return { electron, handlers, invoke, failUnlinkPaths: new Set() };
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

// 仅拦截 unlinkSync（#10 注入失败）；其余 fs 调用透传真实实现（含测试自用的 rmSync/mkdirSync/...）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  const unlinkSync = (p, ...rest) => {
    if (ho.failUnlinkPaths.has(String(p))) {
      const err = new Error('EACCES: simulated unlink failure (test)');
      err.code = 'EACCES';
      throw err;
    }
    return actual.unlinkSync(p, ...rest);
  };
  const out = { ...actual, unlinkSync };
  const baseDefault = (actual.default && typeof actual.default === 'object') ? actual.default : actual;
  out.default = Object.assign({}, baseDefault, { unlinkSync });
  return out;
});

let subagent;    // src/app/subagent.js
let windowState; // src/app/window.js

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.resetModules();
  ho.handlers.clear();
  ho.invoke.mockClear();
  ho.failUnlinkPaths.clear();
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
  ho.failUnlinkPaths.clear();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- 常量 / 脚手架 ----------

// 非敷衍、无声称路径的有效文本（isTrivialResult=false 且 checkResultAuthenticity=null）
const VALID_RESULT = '检查完成：已阅读三个源文件，定位到两处逻辑缺陷。建议按修复方案 A 与 B 处理，并补充回归测试。';
// 敷衍文本（长度 < 30，isTrivialResult=true），无声称路径
const TRIVIAL = '已完成';
const DAY_MS = 24 * 60 * 60 * 1000;

function acc(id, providerId) {
  return { id, providerId, partition: 'persist:' + providerId + ':' + id };
}

function flushMicrotasks() {
  let p = Promise.resolve();
  for (let i = 0; i < 5; i++) p = p.then(() => {});
  return p;
}

function resultsDirOf(baseDir) {
  return path.join(baseDir, '.cuckoo', 'subagent-results');
}

/**
 * 起一个子代理任务：
 *   父窗口 id=1（parentStore.state.selectedProjectDir = opts.projectDir，默认 TMP）
 *   → runAgent 取到 projectDir → **同步**触发 _cleanupOldResults → 建子窗口 → 注册任务。
 * 注意：runAgent 是 async 函数，但第一个 await（L942）之前的代码全同步执行，
 *   故本函数返回时 cleanup 与任务注册均已完成。
 * @param opts.projectDir 显式 undefined 表示使用默认 TMP；显式 null 表示强制 projectDir=null。
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

  // 父窗口（id=1）：runAgent 从这里读 selectedProjectDir → projectDir
  const parentProjectDir = opts.projectDir !== undefined ? opts.projectDir : TMP;
  const parentStore = { state: { selectedProjectDir: parentProjectDir } };
  const parentWin = {
    id: 1,
    webContents: { send: vi.fn(), isDestroyed: () => false },
    isDestroyed: () => false,
    close: vi.fn(),
    on: () => {},
  };
  const parentView = { webContents: { send: vi.fn(), isDestroyed: () => false }, isDestroyed: () => false };
  windowState.addWindow(parentWin, 'main-profile', providerId, parentStore, parentView, false);

  // 子代理窗口（双层：win=壳 / view=AI 页；提醒与反查均用 view）
  const winWc = { tag: 'win', send: vi.fn(), isDestroyed: () => false };
  const viewWc = { tag: 'view', send: vi.fn(), isDestroyed: () => false };
  const win = { id: 900, webContents: winWc, isDestroyed: () => false, close: vi.fn(), on: () => {} };
  const view = { webContents: viewWc, isDestroyed: () => false };
  const subStore = { state: { selectedProjectDir: parentProjectDir } };

  subagent.injectSubagentDeps({
    createWindow: () => {
      windowState.addWindow(win, 'subagent-tmp', providerId, subStore, view, true);
      return win.id;
    },
    profileManager: pm,
  });

  const p = subagent.runAgent({
    parentWindowId: 1, agentName: 'a', task: 't', systemPrompt: 's',
    timeoutMs: opts.timeoutMs,
  });
  p.catch(() => {}); // 标记已处理，避免未处理拒绝

  const state = subagent.findTaskByWebContents(viewWc);
  assert.ok(state, 'runAgent 应同步注册任务到 activeTasks');
  return { p, win, winWc, view, viewWc, parentWin, parentStore, state, pm };
}

/** 完成 observer-ready 握手 → 断言进入 working */
function handshake(env) {
  assert.strictEqual(subagent.onSubagentReady(env.viewWc), true, '首次握手应命中 starting 任务');
  return flushMicrotasks().then(() => {
    assert.strictEqual(env.state.phase, 'working');
    return env;
  });
}

// =====================================================================
// 1-5 落盘 + resolve 文本拼接
// =====================================================================

describe('T2g 落盘（handleCandidateResult → {projectDir}/.cuckoo/subagent-results/{taskId}.md）', () => {
  test('#1 落盘成功：文件存在 + 内容 === 提交文本 + res.resultFile 为绝对路径', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: VALID_RESULT });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.accepted, true);

      const expected = path.join(resultsDirOf(TMP), env.state.taskId + '.md');
      assert.strictEqual(res.resultFile, expected, 'resultFile 应为 {projectDir}/.cuckoo/subagent-results/{taskId}.md');
      assert.ok(fs.existsSync(expected), '落盘文件应存在');
      assert.strictEqual(
        fs.readFileSync(expected, 'utf-8'),
        VALID_RESULT,
        '落盘内容应为原始 text（不含 [完整报告]/[质量警示] 追加段）',
      );

      return env.p.then(() => {});
    });
  });

  test('#2 落盘失败：resultsDir 被同名文件占位 → {success:false,accepted:false,error:"落盘失败: ..."} 且不 resolve', () => {
    const env = startTask();
    // 用同名文件占位 resultsDir，使 mkdirSync(recursive) 失败
    const blocker = resultsDirOf(TMP);
    fs.mkdirSync(path.dirname(blocker), { recursive: true });
    fs.writeFileSync(blocker, 'blocker');

    return handshake(env).then(() => {
      let settled = false;
      env.p.then(() => { settled = true; }, () => { settled = true; });

      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: VALID_RESULT });
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.accepted, false);
      assert.match(res.error, /^落盘失败: /, 'error 应以 "落盘失败: " 开头: ' + res.error);
      assert.strictEqual(res.resultFile, undefined, '失败时不应有 resultFile');

      assert.strictEqual(env.state.phase, 'working', '落盘失败不应完成任务');
      assert.ok(subagent.findTaskByWebContents(env.viewWc), '任务应仍在注册表（等超时/重试）');

      return flushMicrotasks().then(() => {
        assert.strictEqual(settled, false, '落盘失败不应 resolve（也不应 reject）');
        assert.ok(
          !fs.existsSync(path.join(resultsDirOf(TMP), env.state.taskId + '.md')),
          '不应产生部分写入的 .md',
        );
      });
    });
  });

  test('#3 projectDir=null → 回落 process.cwd()/.cuckoo/subagent-results/{taskId}.md（用例后清理）', () => {
    const env = startTask({ projectDir: null });
    const created = [];
    return handshake(env)
      .then(() => {
        assert.strictEqual(env.state.projectDir, null, '前置：state.projectDir 应为 null');

        const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: VALID_RESULT });
        assert.strictEqual(res.success, true);
        const expected = path.join(resultsDirOf(process.cwd()), env.state.taskId + '.md');
        assert.strictEqual(res.resultFile, expected, '应回落到 process.cwd() 前缀');
        created.push(expected);
        assert.ok(fs.existsSync(expected));
        return env.p;
      })
      .then(() => {
        // 用例后清理，避免污染工作区
        for (const f of created) {
          try { fs.rmSync(f, { force: true }); } catch (_) { /* ignore */ }
        }
      });
  });

  test('#4 无 warning：resolve 文本 = 正文 + "\n\n[完整报告] <path>"（精确相等）', () => {
    const env = startTask();
    return handshake(env).then(() => {
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: VALID_RESULT });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.warning, undefined, '无 warning 时 res.warning 应为 undefined');
      assert.ok(res.resultFile);

      return env.p.then((text) => {
        const expected = VALID_RESULT + '\n\n[完整报告] ' + res.resultFile;
        assert.strictEqual(text, expected, 'resolve 文本应精确等于 正文 + [完整报告]');
        assert.ok(!text.includes('[质量警示]'), '无 warning 时不应出现质量警示段');
        assert.strictEqual(env.state.phase, 'completed');
      });
    });
  });

  test('#5 有 warning：resolve 文本 = 正文 → [完整报告] → [质量警示]（顺序断言）', () => {
    const env = startTask();
    return handshake(env).then(() => {
      env.state.supplementCount = 2; // 触发 T2d「敷衍超限」warning
      const res = subagent.handleCandidateResult(env.viewWc, { type: 'subagent_result', text: TRIVIAL });
      assert.strictEqual(res.success, true);
      assert.ok(res.warning, '应有 warning: ' + res.warning);
      assert.ok(res.resultFile);

      return env.p.then((text) => {
        const expected = TRIVIAL + '\n\n[完整报告] ' + res.resultFile + '\n\n[质量警示] ' + res.warning;
        assert.strictEqual(text, expected, 'resolve 文本应为 正文 → 完整报告 → 质量警示');

        const iText = text.indexOf(TRIVIAL);
        const iReport = text.indexOf('[完整报告]');
        const iWarn = text.indexOf('[质量警示]');
        assert.ok(iText >= 0 && iReport > iText && iWarn > iReport, '段落顺序应为 正文 < 完整报告 < 质量警示');
      });
    });
  });
});

// =====================================================================
// 6-10 清理（_cleanupDir / _cleanupOldResults，经 runAgent 间接驱动）
// =====================================================================

describe('T2g 清理（_cleanupDir / _cleanupOldResults，经 runAgent 间接驱动）', () => {
  /** 造一个文件并置其 mtime 为 ageMs 之前 */
  function makeFile(dir, name, ageMs, content) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, content || name);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  }

  test('#6 _cleanupDir 删除 mtime > 7 天的文件', () => {
    const dir = resultsDirOf(TMP);
    const oldFile = makeFile(dir, 'old.md', 8 * DAY_MS);
    assert.ok(fs.existsSync(oldFile), '前置：文件已建');

    const env = startTask(); // runAgent 同步触发 _cleanupOldResults(TMP)
    assert.ok(env.state, 'runAgent 应已注册任务');
    assert.strictEqual(fs.existsSync(oldFile), false, '> 7 天文件应被删除');
  });

  test('#7 _cleanupDir 保留 mtime < 7 天文件（含"恰好 7 天"边界）', () => {
    const dir = resultsDirOf(TMP);
    const recent = makeFile(dir, 'recent.md', 1 * DAY_MS);
    const almost7d = makeFile(dir, 'almost7d.md', 7 * DAY_MS - 10000); // 距 7 天差 10s

    startTask();
    assert.ok(fs.existsSync(recent), '1 天前文件应保留');
    assert.ok(fs.existsSync(almost7d), '恰好 7 天（判据 > 严格大于）文件应保留');
  });

  test('#8 _cleanupDir 目录不存在 → 静默不抛、不产生清理失败 warn', () => {
    assert.strictEqual(fs.existsSync(path.join(TMP, '.cuckoo')), false, '前置：.cuckoo 目录不存在');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const env = startTask();
      assert.ok(env.state, 'runAgent 应完成注册（清理静默走过，未抛错）');
      const cleanupWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('清理失败'));
      assert.strictEqual(cleanupWarns.length, 0, '目录不存在不应产生清理失败 warn');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('#9 _cleanupOldResults 对 subagent-results + subagent-tools 两目录各清一次', () => {
    const rDir = resultsDirOf(TMP);
    const tDir = path.join(TMP, '.cuckoo', 'subagent-tools');
    const rFile = makeFile(rDir, 'old-r.md', 8 * DAY_MS);
    const tFile = makeFile(tDir, 'old-t.log', 8 * DAY_MS);
    assert.ok(fs.existsSync(rFile) && fs.existsSync(tFile), '前置：两目录过期文件已建');

    startTask();
    assert.strictEqual(fs.existsSync(rFile), false, 'subagent-results 过期文件应被删除');
    assert.strictEqual(fs.existsSync(tFile), false, 'subagent-tools 过期文件应被删除');
  });

  test('#10 _cleanupDir 单文件 unlink 失败 → 不中断（catch 继续处理后续文件）', () => {
    const dir = resultsDirOf(TMP);
    const failA = makeFile(dir, 'a-fail.md', 8 * DAY_MS);
    const failB = makeFile(dir, 'b-fail.md', 8 * DAY_MS);

    // 注入：这两个文件的 unlinkSync 抛 EACCES（真实 fs 其余调用透传）
    ho.failUnlinkPaths.add(failA);
    ho.failUnlinkPaths.add(failB);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      startTask();
      // 两个文件都尝试过 unlink（都失败）→ 说明循环未被第一个失败打断
      const cleanupWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('清理失败'));
      assert.strictEqual(cleanupWarns.length, 2, '两次 unlink 失败均被 catch（循环未中断），实际: ' + cleanupWarns.length);
      assert.ok(fs.existsSync(failA), 'unlink 失败的文件应仍在（模拟：未删除）');
      assert.ok(fs.existsSync(failB), 'unlink 失败的文件应仍在');
    } finally {
      warnSpy.mockRestore();
      ho.failUnlinkPaths.delete(failA);
      ho.failUnlinkPaths.delete(failB);
    }
  });
});

// 代码观察 1：_cleanupOldResults 只在 runAgent 委派时触发（subagent.ts L851），长期不派发子代理则不会清理
//   —— 与 051 完全一致（实现报告 §五.3 已记录为设计取舍，非缺陷）。
// 代码观察 2：_cleanupOldResults 同时清理 .cuckoo/subagent-tools，但 086 全仓无任何代码写入该目录
//   （review §五 L150/L155 记录，唯一可砍项 1 行）；本测试用真实建目录方式覆盖该分支，未改动生产代码。
// 代码观察 3：projectDir 为 null 时回落 process.cwd()（L803），单元测试下会落到 086 仓库根
//   —— review M-2/M-3 建议补 .gitignore 并评估回退语义；本测试用例 #3 已做用例后清理，不污染工作区。
