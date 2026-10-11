/**
 * 子代理运行器（主进程侧编排）
 *
 * 流程：创建子代理窗口 → 等加载 → 导航到新对话 → 注入提示词+任务
 *      → 等子代理回复完成（无工具调用）→ 取最终文本 → 关闭窗口 → 返回
 *
 * 依赖注入：createWindow / profileManager 由 entry.ts 注入，避免循环依赖。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as windowState from './window.js';
import { setTimeout as delay } from 'node:timers/promises';

type CreateWindowFn = (profile: any) => number;

let _createWindow: CreateWindowFn | null = null;
let _profileManager: any = null;

// ========== 子代理副账号池 ==========
// 池 = profile-list.json 里除「主账号」与「默认打开(autoOpen)账号」外的所有账号（spec §九 决策 3，
// 对齐 0.5.1「主账号专职调度、子代理用副账号」）。
// autoOpen=true 的账号是用户指定「启动即开窗」的常驻账号，隔离出池（避免与常驻窗口抢 partition）。
// 主账号判定为**显式判据**：最近活跃窗口的 profile（getLastActiveProfileId，由
// entry.ts 在窗口获得焦点时写入，子代理窗口不写入）；无记录或记录失效时回退首位。
// 不依赖「数组下标 = 主账号」的隐式假设——删除/重排 profile 不会让真实主账号
// 落入池中（否则子代理与主窗口抢同一 partition，429 坑复现）。
// 游标按派发顺序在池内轮转，串行派发下天然错开各账号的冷却时间（避免单账号被打爆）。
// 池空（除主账号外无其他账号）→ 报错，不借主账号（否则又触发 429）。
// ponytail: 模块级全局游标（单进程单实例）；跨进程/多实例需改为持久化游标。
let _poolCursor = 0;

/**
 * 从副账号池按游标轮转选一个账号。
 * @returns 选定的池账号 profile；池空时抛错
 */
function getSubagentAccount(): any {
  if (!_profileManager) throw new Error('子代理依赖未注入');
  const raw = _profileManager.readProfiles();
  const profiles = Array.isArray(raw) ? raw : [];
  // 主账号 = 最近活跃窗口的 profile（显式判据，不依赖数组位置）；失效则回退首位
  const lastActiveId = _profileManager.getLastActiveProfileId
    ? _profileManager.getLastActiveProfileId()
    : null;
  const main = (lastActiveId && profiles.find((p: any) => p.id === lastActiveId)) || profiles[0] || null;
  const mainId = main ? main.id : null;
  // 池 = 除主账号外、且未勾选「默认打开」的账号。
  // autoOpen=true 是用户指定「启动即开窗」的常驻账号（如各平台的主对话窗口），
  // 视为用户手动占用的账号，隔离出轮转池，避免子代理与其抢同一 partition（429）。
  const pool = profiles.filter((p: any) => p && p.id !== mainId && p.autoOpen !== true);
  if (pool.length === 0) {
    throw new Error('副账号池为空（除主账号与「默认打开」账号外无其他账号）；请先在「窗口管理」新增副账号，或取消某个账号的「默认打开」，子代理不借主账号');
  }
  // 游标归一化到 [0, pool.length)，避免无限递增（首轮 N-3）；
  // 取模后行为与 (cursor % len) 等价，仅让游标保持有界。
  _poolCursor = _poolCursor % pool.length;
  const account = pool[_poolCursor];
  _poolCursor = (_poolCursor + 1) % pool.length;
  return account;
}

/** 由 entry.ts 注入依赖 */
export function injectSubagentDeps(deps: { createWindow: CreateWindowFn; profileManager: any }): void {
  _createWindow = deps.createWindow;
  _profileManager = deps.profileManager;
}

// ========== T2b：子代理五层超时 + observer-ready 握手 ==========
// 权威源：cuckoo-code-master051/src/main/subagent-runner.js L70-95 / L636-733 / L987-1001

/** 层1：总超时 120 分钟（从 run 起算，覆盖 starting + working 全程） */
const DEFAULT_TIMEOUT_MS = 120 * 60 * 1000;
/** 层2：starting 超时 60 秒（observer-ready 握手兜底） */
const STARTING_TIMEOUT_MS = 60 * 1000;
/** 层3：空闲提醒阈值 180 秒（默认）；GLM 首条消息长 + 长思考常超 3 分钟，放宽到 12 分钟 */
const IDLE_TIMEOUT_MS = 180 * 1000;
const IDLE_REMINDER_MAX = 2;
const IDLE_TIMEOUT_BY_PROVIDER: Record<string, number> = { glm: 12 * 60 * 1000 };
/** 层4：静默硬看门狗 15 分钟（最后真实活动后无任何进展 → 强制终止，止损级） */
const SILENCE_TIMEOUT_MS = 15 * 60 * 1000;
/** 层5：轮次硬顶 150（达顶 → force_deliver：提示 AI 整理进展输出 subagent_result） */
const MAX_INTERACTION_ROUNDS = 150;
/** T2d 场景 A：纯文本停顿提醒上限 2 次，之后静默（对齐 051 STALL_REMINDER_MAX） */
const STALL_REMINDER_MAX = 2;
/** T2d 敷衍追问上限 2 次，超限接受最后一次结果并附 warning（对齐 051 §10.2） */
const TRIVIAL_SUPPLEMENT_MAX = 2;
/** T2g：结果落盘文件保留 7 天（对齐 051 RESULTS_CLEANUP_MAX_AGE_MS） */
const RESULTS_CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 降级 partition：主 partition 未登录时，用全新的 worker partition 重建子代理窗口。
 * 权威源：cuckoo-code-master051/src/main/subagent-runner.js L18。 */
const WORKER_PARTITION = 'persist:subagent-worker';

/** 页面加载完成后追加的渲染延迟（对齐 051 L559 的 1500ms） */
const LOGIN_CHECK_DELAY_MS = 1500;

/**
 * 登录态检测 JS：注入子代理 AI 页（view.webContents，非壳 win）执行，返回 { loggedIn, reason }。
 * 三特征：URL 跳登录页 / 聊天输入框缺失 / 登录按钮存在。
 * ⚠ 086 双层窗口：必须注入 view.webContents（AI 页）；注入 win.webContents（壳）会检测错误页面。
 * 权威源：cuckoo-code-master051/src/main/subagent-runner.js L101-123。
 */
const LOGIN_CHECK_JS = `(function () {
  try {
    const url = location.href;
    if (/sign_in|login|auth|oauth/i.test(url)) {
      return { loggedIn: false, reason: 'url-redirected-to-login' };
    }
    const textarea = document.querySelector('textarea');
    const editable = document.querySelector('[contenteditable="true"]');
    if (!textarea && !editable) {
      return { loggedIn: false, reason: 'no-chat-input' };
    }
    const loginBtn = Array.from(document.querySelectorAll('button, a')).find((el) => {
      const t = (el.textContent || '').trim();
      // 2026-10-01 修复（对齐 051）：原 /登录/ 宽匹配会误命中"含登录字样的长文本"（对话标题"xxx登录"、
      //   "退出登录"、引导文案"登录以同步"等）→ 已登录却判未登录。改为只认【纯登录入口】短文本（整条匹配 + ≤10 字 + 可见）。
      if (!t || t.length > 10) return false;
      if (!/^(微信|手机号|手机|账号|邮箱|扫码|QQ|一键)?\s*(登录|登入|Log ?in|Sign ?in)$/i.test(t)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (loginBtn) {
      return { loggedIn: false, reason: 'login-button-present' };
    }
    return { loggedIn: true };
  } catch (err) {
    return { loggedIn: false, reason: 'check-error:' + err.message };
  }
})()`;

type SubagentPhase = 'starting' | 'working' | 'force_deliver' | 'completed' | 'failed';

/** 单次子代理任务的运行时状态（替代旧 pending 单层 map） */
interface SubagentTaskState {
  taskId: string;
  windowId: number;
  win: any;
  view: any;
  provider: string | null;
  phase: SubagentPhase;
  timer: any;
  startingTimer: any;
  idleTimer: any;
  silenceTimer: any;
  interactionCount: number;
  idleReminderCount: number;
  /** T2d：是否有工具活动（markActivity 置 true；停住检测用，策略 A/B 判据） */
  hasToolActivity: boolean;
  /** T2d：纯文本停顿提醒计数（上限 STALL_REMINDER_MAX，超限静默） */
  stallReminderCount: number;
  /** T2d：敷衍追问计数（上限 TRIVIAL_SUPPLEMENT_MAX，超限接受最后一次） */
  supplementCount: number;
  /** T2d：任务创建时间戳（真实性校验比对结果声称文件 mtime 用） */
  startedAt: number;
  /** T2d：任务项目目录（真实性校验解析相对路径用；runAgent 注入） */
  projectDir: string | null;
  /** 当前子窗口 partition（登录降级判定；初始 = 池账号 partition） */
  currentPartition: string | null;
  /** 子代理配置（worker partition 降级重建窗口时复制到新 profile） */
  subagentConfig: any;
  readyPromise: Promise<boolean> | null;
  readyResolve: ((v: boolean) => void) | null;
  resolve: ((text: string) => void) | null;
  reject: ((err: Error) => void) | null;
}

/** 活跃任务注册表：taskId → state */
const activeTasks = new Map<string, SubagentTaskState>();
let _taskSeq = 0;

function getIdleTimeoutMs(provider: string | null): number {
  return (provider && IDLE_TIMEOUT_BY_PROVIDER[provider]) || IDLE_TIMEOUT_MS;
}

/** 按 webContents 反查子任务（execute-tool/execute-js/subagent-round/subagent-ready 共用） */
export function findTaskByWebContents(sender: any): SubagentTaskState | null {
  if (!sender) return null;
  for (const s of activeTasks.values()) {
    if (s.win && s.win.webContents === sender) return s;
    if (s.view && s.view.webContents === sender) return s;
  }
  return null;
}

function _isTerminal(state: SubagentTaskState): boolean {
  return state.phase === 'completed' || state.phase === 'failed';
}

function _clearTaskTimers(state: SubagentTaskState): void {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.startingTimer) { clearTimeout(state.startingTimer); state.startingTimer = null; }
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  if (state.silenceTimer) { clearTimeout(state.silenceTimer); state.silenceTimer = null; }
}

/** 层3：重置空闲计时器（180s 无活动 → 提醒；×IDLE_REMINDER_MAX 后静默） */
function _resetIdleTimer(state: SubagentTaskState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => _onIdleTimeout(state), getIdleTimeoutMs(state.provider));
}

function _onIdleTimeout(state: SubagentTaskState): void {
  if (!activeTasks.has(state.taskId) || _isTerminal(state)) return;
  if (state.idleReminderCount < IDLE_REMINDER_MAX) {
    const idleMin = Math.round(getIdleTimeoutMs(state.provider) / 60000);
    _sendStallReminder(state, '【系统提醒】距离上次活动已超过 ' + idleMin + ' 分钟，请立即继续执行任务。如果已完成，输出 subagent_result 代码块。');
    state.idleReminderCount++;
    _resetIdleTimer(state); // 重置继续监控
  } else {
    console.log('[子代理] 空闲提醒已达上限，静默等待总超时:', state.taskId);
  }
}

/** 每个 profile 正在跑的子代理数量（用于飞书消息拦截等） */
const runningByProfile = new Map<string, number>();

/** 该 profile 是否有子代理正在运行 */
export function hasRunningSubagent(profileId: string): boolean {
  return !!profileId && (runningByProfile.get(profileId) || 0) > 0;
}

function incRunning(profileId: string): void {
  if (!profileId) return;
  runningByProfile.set(profileId, (runningByProfile.get(profileId) || 0) + 1);
}
function decRunning(profileId: string): void {
  if (!profileId) return;
  const n = (runningByProfile.get(profileId) || 0) - 1;
  if (n <= 0) runningByProfile.delete(profileId);
  else runningByProfile.set(profileId, n);
}

/** 层4：重置静默硬看门狗（仅 markActivity/recordRound 调用；系统自身提醒不重置） */
function _resetSilenceTimer(state: SubagentTaskState): void {
  if (state.silenceTimer) clearTimeout(state.silenceTimer);
  state.silenceTimer = setTimeout(() => _onSilenceTimeout(state), SILENCE_TIMEOUT_MS);
}

function _onSilenceTimeout(state: SubagentTaskState): void {
  if (!activeTasks.has(state.taskId) || _isTerminal(state)) return;
  _failTask(state.taskId, '任务静默超时（最后活动后 ' + Math.round(SILENCE_TIMEOUT_MS / 1000) + 's 无任何进展，强制终止）');
}

/**
 * 发送停住/提醒（复用 subagent-reminder 通道）。
 * 086 窗口为双层结构：win=壳 BrowserWindow（preload=shell-preload），view=AI 页 WebContentsView
 * （preload=bridge/entry.js）。subagent-reminder 监听端在 AI 页（overlay/chat-input.ts），故提醒必须
 * 发 view.webContents，而非 win.webContents（壳页面无该通道监听）。051 为单层窗口，发 win 正确；
 * 086 移植时需适配为 view（详见 docs/arch/04-runtime.md §1）。
 */
function _sendStallReminder(state: SubagentTaskState, message: string): void {
  if (!state || !state.view || !state.view.webContents || state.view.webContents.isDestroyed()) return;
  try {
    state.view.webContents.send('subagent-reminder', { message });
  } catch (err: any) {
    console.warn('[子代理] 提醒发送失败（窗口可能已关）:', state.taskId, err && err.message);
  }
}

/**
 * 信号：工具执行（execute-tool/execute-js）→ 重置 idle + silence 计时器。
 * force_deliver 后持续拦截后续工具。
 * @returns 是否允许继续执行（force_deliver 时 false）
 */
export function markActivity(state: SubagentTaskState | null): boolean {
  if (!state) return false;
  // 工具执行 = 真实活动 → 重置静默硬看门狗（任何阶段，含 force_deliver）
  _resetSilenceTimer(state);
  // T2d：标记有工具活动（停住检测策略 B 判据）。
  // 注：置位有意提到 force_deliver 判断之前（051 置于其后）——force_deliver 已硬顶，
  // 此时子代理输出纯文本不应再触发场景 A「请继续执行任务」提醒，故让其走策略 B 静默。
  state.hasToolActivity = true;
  if (state.phase === 'force_deliver') return false;
  state.idleReminderCount = 0; // 恢复活跃 → 空闲提醒计数归零
  _resetIdleTimer(state);
  return true;
}

/**
 * 信号：AI 回复到达（subagent-round）→ 轮次计数 + 重置 silence；达硬顶转 force_deliver。
 * 一次回复计 1 轮（无论回复内几个代码块）。
 * @returns 是否允许继续执行（force_deliver 时 false）
 */
export function recordRound(state: SubagentTaskState | null): boolean {
  if (!state) return false;
  // AI 回复到达 = 真实活动 → 重置静默硬看门狗（任何阶段，含 force_deliver）
  // 注意（M-2，051 保真）：force_deliver 阶段仍先重置 silence 再返回 false（051 L715 先重置、L718 才判），
  // 因此层4 止损看门狗对「含工具块轮次」在该阶段不触发，仅剩层1 总超时（120min）兜底。
  // 此为 051 逐行一致的设计取舍，非缺陷，不改行为。
  _resetSilenceTimer(state);
  if (state.phase === 'force_deliver') return false; // 进入后不再计数
  state.interactionCount++;
  if (state.interactionCount >= MAX_INTERACTION_ROUNDS) {
    state.phase = 'force_deliver';
    console.warn('[子代理] 轮次硬顶触发（' + MAX_INTERACTION_ROUNDS + ' 轮）:', state.taskId);
    _sendStallReminder(state, '【系统提示】已达到最大交互轮次（' + MAX_INTERACTION_ROUNDS + ' 轮）。请立即整理当前工作进展，输出完整的 subagent_result 代码块交付结果。未完成的部分在结果中说明。');
    return false;
  }
  return true;
}

/**
 * 按 windowId 中止任务（subagent-abort IPC）。
 * 权威源：cuckoo-code-master051/src/main/subagent-runner.js L1169-1177 abortByWindowId。
 * 086 双层窗口下 state.windowId 与 state.win.id 恒一致（runAgent L812 / _fallbackToWorker L511-512 同步赋值）；
 * 登录降级重建期间 state.win 短暂为 null 但 state.windowId 仍持有效 id，故直接按 windowId 匹配即可。
 * @param windowId 子窗口 id
 * @returns 是否命中并中止
 */
export function abortByWindowId(windowId: number): boolean {
  for (const state of activeTasks.values()) {
    if (state.windowId === windowId) {
      _failTask(state.taskId, '子 Agent 任务已被用户中止');
      return true;
    }
  }
  return false;
}

/**
 * 按 windowId 聚焦子窗口（focus-subagent-window IPC）。
 * 权威源：cuckoo-code-master051/src/main/subagent-runner.js L1184-1192 focusByWindowId。
 * 086 双层窗口：壳 BrowserWindow 为 state.win，聚焦用 state.win（非 view）。
 * @param windowId 子窗口 id
 * @returns 是否找到并聚焦
 */
export function focusByWindowId(windowId: number): boolean {
  for (const state of activeTasks.values()) {
    const win = state.win;
    if (win && win.id === windowId && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      return true;
    }
  }
  return false;
}

/**
 * 获取运行中子代理任务的状态列表（供控制台状态展示）。
 * 仅返回 starting / working / force_deliver 阶段的任务。
 * 权威源：cuckoo-code-master051/src/main/subagent-runner.js L1135-1148 getStatusList。
 * 086 差异：state 无 agentType 字段，用 subagentConfig.agentName 作等价（未设时回落「通用」）；
 * windowId 直接取 state.windowId（051 取 state.win.id），恒为 number。
 * provider 为任务所用平台 id（state.provider），未定平台时为 null。
 * @returns {Array<{ taskId, agentType, provider, elapsedMs, windowId }>}
 */
export function getStatusList(): Array<{ taskId: string; agentType: string; provider: string | null; elapsedMs: number; windowId: number }> {
  const list = [];
  for (const state of activeTasks.values()) {
    if (state.phase === 'starting' || state.phase === 'working' || state.phase === 'force_deliver') {
      list.push({
        taskId: state.taskId,
        agentType: (state.subagentConfig && state.subagentConfig.agentName) || '通用',
        provider: state.provider || null,
        elapsedMs: Date.now() - state.startedAt,
        windowId: state.windowId,
      });
    }
  }
  return list;
}

// ========== T10：状态变更推送（对齐 051 subagentRunner.setStatusChangeHandler）==========
// 任务注册表增删时通知装配层（entry.ts）；由装配层决定广播策略（有任务则 1s ticker 推送）。
let _statusChangeHandler: ((tasks: ReturnType<typeof getStatusList>) => void) | null = null;

/**
 * 注册状态变更回调（T10 侧边栏 subagents 面板主进程 push）。
 * 任务加入/移出 activeTasks 时回调，参数为当前 getStatusList() 快照。
 * 对齐 051 subagent-runner.setStatusChangeHandler（main/index.js L361-383）。
 * @param fn 回调；传 null 注销
 */
export function setStatusChangeHandler(fn: ((tasks: ReturnType<typeof getStatusList>) => void) | null): void {
  _statusChangeHandler = fn;
}

/** 内部：任务注册表变更后触发回调（回调异常吞掉，不阻断任务流程） */
function _notifyStatusChange(): void {
  if (!_statusChangeHandler) return;
  try { _statusChangeHandler(getStatusList()); } catch (_) { /* ignore */ }
}

/**
 * observer-ready 握手：子代理窗口 preload 上报（subagent-ready）→ resolve readyPromise。
 * 由 runAgent 的 readyPromise.then 推进 starting → working。
 * @returns 是否命中 starting 阶段的任务
 */
export function onSubagentReady(sender: any): boolean {
  const state = findTaskByWebContents(sender);
  if (!state || state.phase !== 'starting') return false;
  // n-1：readyResolve 为 null 表示握手已处理过（已 resolve、微任务尚未 flush 推进 phase）。
  // 此时重复调用属幂等重复，返回 false 以免 ipc 日志误报 OK。
  if (!state.readyResolve) return false;
  state.readyResolve(true);
  state.readyResolve = null;
  return true;
}

/**
 * 装配 readyPromise 处理器：握手成功 → starting → working（清 startingTimer + 启 idle/silence）。
 * 从 runAgent 内联 .then 提取为复用函数，供 _resetReadyPromise 复用（登录降级重建 readyPromise 时）。
 */
function _attachReadyHandler(state: SubagentTaskState): void {
  const p = state.readyPromise;
  if (!p) return;
  p.then((ok) => {
    if (!ok || state.phase !== 'starting' || _isTerminal(state)) return;
    state.phase = 'working';
    if (state.startingTimer) { clearTimeout(state.startingTimer); state.startingTimer = null; }
    _resetIdleTimer(state);
    _resetSilenceTimer(state);
  }).catch(() => { /* ignore */ });
}

/**
 * 重置 readyPromise（登录降级关旧窗前调用，避免旧窗口 observer 提前 resolve 影响新窗口流程）。
 * 对齐 051 subagent-runner.js L978-981 _resetReadyPromise。
 */
function _resetReadyPromise(state: SubagentTaskState): void {
  state.readyResolve = null;
  state.readyPromise = new Promise<boolean>((resolve) => { state.readyResolve = resolve; });
  _attachReadyHandler(state);
}

/**
 * 等 AI 页加载完成（did-finish-load）后再叠加短延迟——登录检测必须在页面渲染后执行。
 * ⚠ 不门控的后果（T2e-review Blocker-1）：entry.ts 的 loadURL 是同步发起未 await 的，
 * 首屏 >1.5s 时 LOGIN_CHECK_JS 会在空白页 / 导航中执行 → no-chat-input / execute-error
 * → 误判未登录 → 关掉已登录窗口 → 空 worker partition 必然失败。
 * 权威源：051 subagent-runner.js L557-560（did-finish-load 内再等 1500ms）。
 * 测试替身的 view.webContents 无 once → 走短延迟分支（无真实加载事件可等）。
 */
function _whenPageReady(state: SubagentTaskState): Promise<void> {
  const wc = state.view && state.view.webContents;
  if (!wc || typeof wc.once !== 'function' || wc.isDestroyed()) return delay(LOGIN_CHECK_DELAY_MS);
  // 页面已加载完成（无进行中导航）→ 无需等事件
  if (typeof wc.isLoading === 'function' && !wc.isLoading()) return delay(LOGIN_CHECK_DELAY_MS);
  return new Promise<void>((resolve) => {
    wc.once('did-finish-load', () => { delay(LOGIN_CHECK_DELAY_MS).then(resolve, resolve); });
  });
}

/**
 * 注入 JS 检测子代理登录态。
 * ⚠ 086 双层窗口：必须注入 view.webContents（AI 页）；注入 win.webContents（壳）会检测错误页面。
 * 恒返回对象、永不返回 null（保真 051 L846-854）——null 三态语义会让真实 view 销毁场景
 * 静默跳过登录流程、丢失降级机会与明确报错（T2e-review Major-1）。
 * @returns 检测结果；失败一律视为未登录（交由 _fallbackToWorker 走降级）
 */
async function _checkLogin(state: SubagentTaskState): Promise<{ loggedIn: boolean; reason?: string }> {
  const view = state.view;
  const wc = view && view.webContents;
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
    return { loggedIn: false, reason: 'view-destroyed' };
  }
  try {
    return await wc.executeJavaScript(LOGIN_CHECK_JS);
  } catch (err: any) {
    return { loggedIn: false, reason: 'execute-error:' + (err && err.message) };
  }
}

/**
 * 登录成功流程（对齐 051 subagent-runner.js L585-618 _handleLoggedIn）：
 *   写 pendingProjectDir → 等 observer-ready 握手（readyPromise）→ 进 working → 发首条消息。
 *
 * ⚠ 086 差异：
 *   1) 首条消息不在此发送——086 由 bridge/subagent.ts 的 initProject（子窗口自身触发）发送，
 *      主进程侧无需（也不应）再发 subagent-task，否则重复。见 docs/arch/04-runtime.md §四·六。
 *   2) starting→working 的推进由 readyPromise handler（_attachReadyHandler）完成。
 *   3) EXPERT_MODE_ENABLED=false，专家模式旁路，无需移植。
 */
async function _handleLoggedIn(state: SubagentTaskState): Promise<void> {
  console.log('[子代理] 子窗口登录态正常:', state.taskId, 'partition=' + state.currentPartition);
  // 写 pendingProjectDir：新会话产生 URL 时由 sessionStore.handleUrlChange 自动绑定
  try {
    const ctx = windowState.getWindowContext(state.windowId);
    const store = ctx && ctx.sessionStore;
    if (store && state.projectDir) {
      store.state.pendingProjectDir = state.projectDir;
      console.log('[子代理] pendingProjectDir 已写入:', state.projectDir);
    }
  } catch (_) { /* ignore */ }
}

/**
 * 检测登录态，未登录走降级路径（对齐 051 subagent-runner.js L768-841）。
 * 086 适配：检测注入 view.webContents；降级用 state.subagentConfig 复制配置调 _createWindow；
 * 重建后刷新 state.win/view/windowId（findTaskByWebContents / 关窗用）。
 * 采用 promise 链（非 await）实现，便于测试替身同步驱动。
 * 检测前经 _whenPageReady 门控（did-finish-load + 1500ms），避免页面未加载完误判未登录
 * （T2e-review Blocker-1：051 L557-560 在 did-finish-load 内再等 1500ms）。
 */
function _checkLoginAndFallback(state: SubagentTaskState): Promise<void> {
  if (_isTerminal(state)) return Promise.resolve();
  return _whenPageReady(state).then(() => {
    if (_isTerminal(state)) return;
    return _checkLogin(state).then((check) => {
      if (check.loggedIn) return _handleLoggedIn(state);
      return _fallbackToWorker(state, check);
    });
  });
}

/**
 * 为窗口绑定 closed 处理（初始窗口与降级重建窗口共用）。
 * 用窗口实例比对避免降级关窗时新旧窗口串线。
 * 缺此 handler 时用户手动关窗不会终止 state → runAgent 挂到 120min 总超时
 * （T2e-review Major-2）。权威源：051 subagent-runner.js L568-580。
 */
function _attachClosedHandler(win: any, state: SubagentTaskState): void {
  if (!win || typeof win.on !== 'function') return;
  win.on('closed', () => {
    if (state.win !== win) return;
    if (!_isTerminal(state)) _failTask(state.taskId, '子窗口被手动关闭');
  });
}

/**
 * 主 partition 未登录时的降级：重建 worker partition 子窗口并再次检测。
 * @param check 首次检测结果（用于日志）；可为 null
 */
async function _fallbackToWorker(state: SubagentTaskState, check: { loggedIn: boolean; reason?: string }): Promise<void> {
  if (state.currentPartition === WORKER_PARTITION) {
    // 已在 worker partition 仍未登录
    _failTask(state.taskId, 'worker partition 未登录，请手动登录子窗口后重试');
    try { if (state.win && !state.win.isDestroyed()) state.win.close(); } catch (_) { /* ignore */ }
    return;
  }
  console.warn('[子代理] 主 partition 未登录，降级到 worker partition:', state.taskId, check && check.reason);
  // 重置 readyPromise：避免旧窗口 observer-ready 到达时 resolve 影响降级流程
  _resetReadyPromise(state);
  const oldWin = state.win;
  state.win = null;
  state.view = null;
  try { if (oldWin && !oldWin.isDestroyed()) oldWin.close(); } catch (_) { /* ignore */ }
  state.currentPartition = WORKER_PARTITION;
  const fallbackProfile = {
    id: 'subagent-worker-' + state.taskId,
    providerId: state.provider || 'deepseek',
    name: '子 Agent - ' + ((state.subagentConfig && state.subagentConfig.agentName) || '通用'),
    partition: WORKER_PARTITION,
    isSubagent: true,
    subagentConfig: state.subagentConfig,
  };
  // runAgent L707 已保证 _createWindow 非 null；跨函数无法保留收窄，此处仅做类型断言（无运行时分支）
  const createWindow = _createWindow as CreateWindowFn;
  let fallbackWindowId: number;
  try {
    fallbackWindowId = createWindow(fallbackProfile);
  } catch (err: any) {
    _failTask(state.taskId, 'worker partition 子窗口创建失败: ' + (err && err.message));
    return;
  }
  const ctx = windowState.getWindowContext(fallbackWindowId);
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) {
    _failTask(state.taskId, 'worker partition 子窗口创建失败');
    return;
  }
  state.windowId = fallbackWindowId;
  state.win = ctx.win;
  state.view = ctx.view;
  try {
    if (ctx.sessionStore && state.projectDir) ctx.sessionStore.state.selectedProjectDir = state.projectDir;
  } catch (_) { /* ignore */ }
  _attachClosedHandler(ctx.win, state);
  // 等新窗口渲染后二次检测（同样 did-finish-load 门控，Minor-1）
  return _whenPageReady(state).then(() => {
    if (_isTerminal(state)) return;
    return _checkLogin(state).then((fallbackCheck) => {
      if (fallbackCheck.loggedIn) return _handleLoggedIn(state);
      _failTask(state.taskId, 'worker partition 未登录，请手动登录子窗口后重试');
      try { if (state.win && !state.win.isDestroyed()) state.win.close(); } catch (_) { /* ignore */ }
    });
  });
}

/** 失败终止：清计时器、关窗、reject（并解除 readyPromise 悬挂） */
function _failTask(taskId: string, reason: string): void {
  const state = activeTasks.get(taskId);
  if (!state) return;
  if (_isTerminal(state)) return;
  state.phase = 'failed';
  _clearTaskTimers(state);
  console.error('[子代理] 任务失败:', taskId, reason);
  const win = state.win;
  state.win = null;
  if (win && !win.isDestroyed()) {
    try { win.close(); } catch (_) { /* ignore */ }
  }
  if (state.readyResolve) { state.readyResolve(false); state.readyResolve = null; }
  if (state.reject) { state.reject(new Error(reason)); state.reject = null; }
  activeTasks.delete(taskId);
  _notifyStatusChange();
}

/**
 * 完成任务公共逻辑：标记 completed、清计时器、resolve、移出注册表（幂等）。
 * @param text 交付文本（始终存在的主载荷）
 * @param meta 可选元信息。数据泥团收口为对象，对齐 051 _completeTask(state, data) 形态（D-1）：
 *   - resultFile T2g 落盘路径。非空时追加 "[完整报告] <path>" 到交付文本尾部，
 *     使主 AI 可见完整报告位置（086 runAgent 返回 string，非 051 的对象 {resultFile,preview}）。
 *   - warning T2d 质量警告（敷衍超限 / 真实性校验）。非空时追加到交付文本尾部，
 *     使 warning 经 resolve → runAgent 返回值 → runAgent 工具 ToolResult 到达主 AI 与用户
 *     （Minor-2：对齐 051 经 state.resolve({success,data}) 的 warning 送达语义）。
 *   拼接顺序在函数内单一确定（resultFile 先、warning 后），调用方无需核对顺序。
 */
function _completeTask(
  state: SubagentTaskState,
  text: string,
  meta?: { warning?: string | null; resultFile?: string | null }
): void {
  const warning = meta?.warning;
  const resultFile = meta?.resultFile;
  if (!state || _isTerminal(state)) return;
  state.phase = 'completed';
  _clearTaskTimers(state);
  const resolve = state.resolve;
  state.resolve = null;
  state.reject = null;
  if (state.readyResolve) { state.readyResolve(false); state.readyResolve = null; }
  activeTasks.delete(state.taskId);
  _notifyStatusChange();
  if (resolve) {
    let out = text || '';
    if (resultFile) out += '\n\n[完整报告] ' + resultFile;
    if (warning) out += '\n\n[质量警示] ' + warning;
    resolve(out);
  }
}

/**
 * T2g 清理单个目录中 mtime 超过 7 天的文件（对齐 051 _cleanupDir L901-922）。
 * 目录不存在 → 静默返回（不抛错）。
 * @param dir 待清理目录绝对路径
 */
function _cleanupDir(dir: string): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return; // 目录不存在，忽略
  }
  const now = Date.now();
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && now - stat.mtimeMs > RESULTS_CLEANUP_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        console.log('[子代理] 清理过期结果文件:', file);
      }
    } catch (err: any) {
      console.warn('[子代理] 清理失败:', filePath, err && err.message);
    }
  }
}

/**
 * T2g 清理过期的结果落盘文件（> 7 天，对齐 051 _cleanupOldResults L893-898）。
 * 每次 runAgent 委派任务时对当前 projectDir 的结果目录 + 工具日志目录各执行一次。
 * @param projectDir 项目根目录（缺失时跳过清理）
 */
function _cleanupOldResults(projectDir: string | null): void {
  if (!projectDir) return;
  _cleanupDir(path.join(projectDir, '.cuckoo', 'subagent-results'));
  _cleanupDir(path.join(projectDir, '.cuckoo', 'subagent-tools'));
}

/** bridge 上报的候选结果 payload（判别联合：T2c） */
export type SubagentCandidatePayload =
  | { type: 'subagent_result'; text: string; partial?: boolean; turns?: number }
  | { type: 'plain_text'; text: string };

/** handleCandidateResult 的返回（判别：accepted 表示是否被接收；handled 表示是否已触发完成） */
export interface SubagentCandidateResult {
  success: boolean;
  accepted: boolean;
  /** plain_text 候选被接收但未触发完成时为 false（质量防线归 T2d） */
  handled?: boolean;
  taskId?: string;
  /** T2g：结果落盘路径（接受结果时写入 projectDir/.cuckoo/subagent-results/{taskId}.md） */
  resultFile?: string;
  error?: string;
  /** T2d：接受结果时附加的质量警告（敷衍超限 / 真实性校验） */
  warning?: string;
}

/**
 * T2d 敷衍检测（对齐 051 subagent-runner.js L290-306）：
 * 长度 < 30 / 敷衍话术开头且 < 100 / 单句且 < 100 三者之一即视为敷衍。
 * @param text 子 Agent 交付的结果文本
 * @returns 是否敷衍（true = 需追问）
 */
export function isTrivialResult(text: any): boolean {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 30) return true;

  const TRIVIAL_PREFIXES = ['我完成了', '任务已完成', '已完成', '全部完成', '做完了', '已经完成', '处理完毕', 'done'];
  for (const p of TRIVIAL_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(p.toLowerCase()) && trimmed.length < 100) return true;
  }

  // 按句号/换行/分号/感叹号/问号切分非空句子
  const sentences = trimmed.split(/[。\n；;！？!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length <= 1 && trimmed.length < 100) return true;

  return false;
}

/**
 * T2d 结果真实性校验（对齐 051 L308-352，启发式）：
 * 从结果文本提取声称的文件路径 → 核对存在性与 mtime
 * （mtime 早于任务 startedAt 视为旧文件冒充）→ 不一致返回 warning 文本，不阻塞 resolve。
 * 无声称路径时返回 null（漏报不告警）。
 * @param state 任务状态（提供 startedAt / projectDir）
 * @param text 结果文本
 * @returns warning 文本或 null
 */
export function checkResultAuthenticity(state: SubagentTaskState, text: string): string | null {
  const candidates = new Set<string>();
  // 注：\x60 即反引号，避免在正则里出现裸反引号
  const patterns = [
    /[A-Za-z]:[\\/][^\s"'\x60，。；]+/g,                 // C:\path\to\file 或 C:/path/to/file
    /(?:^|[\s"'\x60])\/[^\s"'\x60，。；]+/g,            // /abs/path
    /(?:^|[\s"'\x60])(?:[\w.-]+\/)+[\w.-]+\.[\w]+/g,  // relative/path/file.ext
  ];
  for (const re of patterns) {
    const matches = text.match(re);
    if (matches) {
      for (const m of matches) candidates.add(m.trim());
    }
  }

  if (candidates.size === 0) return null;

  const warnings: string[] = [];
  for (const rawPath of candidates) {
    const cleanPath = rawPath.replace(/^["'\x60]+|["'\x60，。；]+$/g, '');
    const absPath = path.isAbsolute(cleanPath)
      ? cleanPath
      : (state.projectDir ? path.join(state.projectDir, cleanPath) : cleanPath);

    let stat: any = null;
    try { stat = fs.statSync(absPath); } catch (_) { /* 不存在 */ }

    if (!stat) {
      warnings.push('声称的文件未找到: ' + cleanPath);
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < state.startedAt) {
      warnings.push('声称的文件修改时间早于任务开始: ' + cleanPath);
    }
  }

  return warnings.length > 0 ? '真实性校验: ' + warnings.join('; ') : null;
}

/**
 * T2d 发送敷衍追问（对齐 051 L1085-1094）：复用 subagent-reminder 通道，
 * 要求子 Agent 重出完整 subagent_result，并递增 supplementCount。
 */
function _sendSupplement(state: SubagentTaskState): void {
  if (!state || !state.view || !state.view.webContents || state.view.webContents.isDestroyed()) return;
  const reminder = '你的最终结果过于简单，不满足交付要求。请重新输出完整的 subagent_result 代码块。\n\n【必须包含】\n1. 实际完成的工作内容（不是"已完成"这类声明）\n2. 具体产出：修改的文件路径、发现的问题清单、分析结论、关键命令输出等\n3. 结果应当可验证、可执行\n\n请基于你此前的工作记录，直接输出完整结果，不要重新执行任务。';
  try {
    state.view.webContents.send('subagent-reminder', { message: reminder });
    state.supplementCount++;
    console.log('[子代理] 已发追问（第 ' + state.supplementCount + ' 次）:', state.taskId);
  } catch (err: any) {
    console.warn('[子代理] 追问发送失败（窗口可能已关）:', state.taskId, err && err.message);
  }
}

/**
 * T2d 处理纯文本停顿（对齐 051 L747-763，场景 A）：
 * 有工具活动 → 策略 B（仅记录，质量检测走正常路径）；
 * 无工具活动 → 发"请继续执行任务"提醒（上限 STALL_REMINDER_MAX，超限静默）。
 */
export function handlePlainText(state: SubagentTaskState, text: string): void {
  if (state.hasToolActivity) {
    console.log('[子代理] plain_text 且有工具活动（策略 B 质量检测回退）:', state.taskId, (text || '').slice(0, 80));
    return;
  }
  if (state.stallReminderCount >= STALL_REMINDER_MAX) {
    console.log('[子代理] 场景 A 停顿提醒已达上限，静默:', state.taskId);
    return;
  }
  state.stallReminderCount++;
  _sendStallReminder(state, '【系统提醒】请继续执行任务。\n\n你当前不应该停顿。请检查：\n1. 如果任务尚未完成，需要执行工具就输出 cuckoo 代码块\n2. 如果任务已经完成，输出 subagent_result 代码块交付结果\n3. 不要输出"好的""我来处理"这类过程性文字\n4. 不要等待用户回复，你是子 Agent，必须自主推进任务');
}

/**
 * 处理 bridge 上报的候选结果（IPC 入口，T2c）。
 * 权威源：cuckoo-code-master051/src/main/subagent-runner.js L1009-1083 handleCandidateResult。
 *
 * T2c 范围：仅处理 subagent_result 围栏完成；plain_text 仅记录（质量防线归 T2d）；
 * 结果落盘 + 7 天清理归 T2g（本函数不落盘）。
 * @param sender 上报方 webContents（按 sender 反查 activeTasks）
 * @param payload { type: 'subagent_result' | 'plain_text', text }
 */
export function handleCandidateResult(sender: any, payload: SubagentCandidatePayload = { type: 'plain_text', text: '' }): SubagentCandidateResult {
  const state = findTaskByWebContents(sender);
  if (!state) {
    return { success: false, accepted: false, error: '未匹配到子 Agent 任务（可能已结束）' };
  }
  // 仅 working / force_deliver 阶段接收结果（对齐 051 L1024-1028；force_deliver 硬顶后必须放行）
  if (state.phase !== 'working' && state.phase !== 'force_deliver') {
    return { success: false, accepted: false, error: '任务不在可接收阶段（当前 ' + state.phase + '）' };
  }

  const type = payload && payload.type;
  const text = payload && payload.text;

  if (type === 'plain_text') {
    // T2d 停住检测：无工具活动 → 提醒继续；有活动 → 策略 B 仅记录
    handlePlainText(state, text as string);
    return { success: true, accepted: true, handled: false };
  }

  if (type !== 'subagent_result') {
    return { success: false, accepted: false, error: '未知 result type: ' + type };
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    return { success: false, accepted: false, error: 'subagent_result 内容为空' };
  }

  // T2d 敷衍检测：未通过且追问次数 < 上限 → 追问，不 resolve（对齐 051 L1044-1048）
  if (isTrivialResult(text) && state.supplementCount < TRIVIAL_SUPPLEMENT_MAX) {
    _sendSupplement(state);
    return { success: true, accepted: true, handled: false };
  }

  // T2d 追问超限：接受最后一次结果，附加 warning（对齐 051 L1050-1055）
  let warning: string | null = null;
  if (isTrivialResult(text) && state.supplementCount >= TRIVIAL_SUPPLEMENT_MAX) {
    warning = '子 Agent 连续 ' + state.supplementCount + ' 次敷衍交付，已接受最后一次结果';
    console.warn('[子代理] ' + warning + ':', state.taskId);
  }

  // T2d 结果真实性校验（启发式）
  const authenticityWarning = checkResultAuthenticity(state, text);
  if (authenticityWarning) {
    warning = warning ? warning + '; ' + authenticityWarning : authenticityWarning;
  }

  // T2g：落盘 projectDir/.cuckoo/subagent-results/{taskId}.md（对齐 051 L1068-1080）
  // 落盘失败 → 返回 error 且不 resolve（真实交付物必须持久化，否则主 AI 拿到即丢）
  let resultFile: string | null = null;
  try {
    const baseDir = state.projectDir || process.cwd();
    const resultsDir = path.join(baseDir, '.cuckoo', 'subagent-results');
    fs.mkdirSync(resultsDir, { recursive: true });
    resultFile = path.join(resultsDir, state.taskId + '.md');
    fs.writeFileSync(resultFile, text, 'utf-8');
    console.log('[子代理] 结果已落盘:', resultFile);
  } catch (err: any) {
    console.error('[子代理] 落盘失败:', err && err.message);
    return { success: false, accepted: false, error: '落盘失败: ' + (err && err.message) };
  }

  // T2c：subagent_result 围栏 = 完成，resolve；warning / resultFile 透传至 resolve 文本尾部
  const taskId = state.taskId;
  _completeTask(state, text, { warning, resultFile });
  console.log('[子代理] subagent_result 已接收并完成:', taskId, warning ? '(warning: ' + warning + ')' : '');
  return { success: true, accepted: true, taskId, resultFile, ...(warning ? { warning } : {}) };
}

/**
 * 运行一个子代理。
 * @param agentName 代理名
 * @param task 任务描述
 * @param systemPrompt 代理系统提示（正文）
 * @param tools 允许的工具（可选，空=全部）
 * @param timeoutMs 总超时（默认 DEFAULT_TIMEOUT_MS = 120 分钟）
 * @returns 子代理最终文本
 */
export async function runAgent(opts: {
  parentWindowId: number;
  agentName: string;
  task: string;
  systemPrompt: string;
  tools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}): Promise<string> {
  if (!_createWindow || !_profileManager) throw new Error('子代理依赖未注入');
  // 层1：总超时默认 120 分钟（覆盖 starting + working 全程）
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  // 取父窗口的项目目录（供子代理窗口 sessionStore 复用）
  const parentCtx = windowState.getWindowContext(opts.parentWindowId);
  const parentStore = parentCtx ? parentCtx.sessionStore : null;
  const projectDir = parentStore ? parentStore.state.selectedProjectDir : null;
  // 父会话 ID（发起子代理的那个对话；为 null 时血缘记不了）
  const parentSessionId = (parentStore && parentStore.state && parentStore.state.currentSessionId) || null;

  // 选号：从副账号池按游标轮转选一个账号（池 = 除主账号外的 profile）
  // 用池账号的独立 partition，与主账号分离，避免同账号并发 429
  // T2g：清理过期结果文件（> 7 天；对齐 051 run() 开头调 _cleanupOldResults L193-194）
  _cleanupOldResults(projectDir || null);

  const account = getSubagentAccount();
  console.log('[子代理] 池轮换到账号 ' + account.id);
  const subProfile = _profileManager.createSubagentProfile(account, opts.agentName);
  subProfile.subagentConfig = {
    agentName: opts.agentName,
    task: opts.task,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools || null,
    maxTurns: opts.maxTurns || null,
    projectDir: projectDir || null, // 传给子代理窗口，供 overlay 显示"当前项目目录"
  };
  console.log('[子代理] 启动 ' + opts.agentName + ' (父窗口 ' + opts.parentWindowId + ', 项目目录 ' + (projectDir || '无') + ')');
  // 对齐 051 L487「无主 partition 直接以 WORKER_PARTITION 建窗」：缺 partition 时回落 WORKER_PARTITION，
  // 避免先建一个 undefined partition（Electron 默认内存 session）的窗口、再触发一次多余降级重建（Minor-3）。
  if (!subProfile.partition) subProfile.partition = WORKER_PARTITION;
  // 运行中计数按【父窗口的 profileId】登记——feishu.ts 用收到消息的那个窗口的
  // ctx.profileId 查询 hasRunningSubagent，故键必须与之一致（086 的 runAgent
  // opts 无 parentProfileId，从父窗口上下文取）。
  const parentProfileId = (parentCtx && parentCtx.profileId) || null;
  if (parentProfileId) incRunning(parentProfileId);
  const windowId = _createWindow(subProfile);

  // 关键：把父窗口的项目目录写入子代理窗口的 sessionStore，
  // 否则子代理执行工具（execute-js 从 ctx.sessionStore.state.selectedProjectDir 取）
  // 时 projectDir 为 null，相对路径/初始化状态都会错。
  try {
    const subCtx = windowState.getWindowContext(windowId);
    if (subCtx && subCtx.sessionStore) {
      if (projectDir) subCtx.sessionStore.state.selectedProjectDir = projectDir;
      // 血缘：子代理对话 -> 父对话（会话 ID 出现时自动绑定）
      if (parentSessionId) {
        subCtx.sessionStore.state.pendingLineage = { parentId: parentSessionId, kind: 'subagent', agentName: opts.agentName };
      }
    }
  } catch (_) { /* ignore */ }

  // ========== 注册任务状态机（五层超时） ==========
  const taskId = 'sub-' + Date.now() + '-' + (++_taskSeq);
  const state: SubagentTaskState = {
    taskId,
    windowId,
    win: null,
    view: null,
    provider: account.providerId || null,
    phase: 'starting',
    timer: null,
    startingTimer: null,
    idleTimer: null,
    silenceTimer: null,
    interactionCount: 0,
    idleReminderCount: 0,
    hasToolActivity: false,
    stallReminderCount: 0,
    supplementCount: 0,
    startedAt: Date.now(),
    projectDir: projectDir || null,
    currentPartition: subProfile.partition,
    subagentConfig: subProfile.subagentConfig || null,
    readyPromise: null,
    readyResolve: null,
    resolve: null,
    reject: null,
  };
  state.readyPromise = new Promise<boolean>((resolve) => { state.readyResolve = resolve; });
  try {
    const subCtx = windowState.getWindowContext(windowId);
    if (subCtx) { state.win = subCtx.win; state.view = subCtx.view; }
  } catch (_) { /* ignore */ }
  // 初始子窗口也注册 closed handler（用户手动关窗 → 终止任务，避免挂到 120min 总超时）。
  // 降级重建的窗口在 _fallbackToWorker 内另行注册；内部 state.win !== win 守卫防串线（Major-2）。
  _attachClosedHandler(state.win, state);
  activeTasks.set(taskId, state);
  _notifyStatusChange();

  const resultPromise = new Promise<string>((resolve, reject) => {
    state.resolve = resolve;
    state.reject = reject;
  });

  // 层1：总超时（从 run 第一行起算）
  state.timer = setTimeout(() => {
    // 保留旧文案「子代理执行超时」前缀以兼容既有调用方/测试（T2 池测试断言该子串）
    _failTask(taskId, '子代理执行超时（任务总超时 ' + Math.round(timeoutMs / 1000) + 's）');
  }, timeoutMs);
  // 层2：starting 超时（observer-ready 握手兜底）
  state.startingTimer = setTimeout(() => {
    if (activeTasks.has(taskId) && state.phase === 'starting') {
      _failTask(taskId, '子窗口启动超时（observer-ready 握手 ' + Math.round(STARTING_TIMEOUT_MS / 1000) + 's 未到达）');
    }
  }, STARTING_TIMEOUT_MS);

  // 握手成功 → starting → working：启动层3 空闲提醒 + 层4 静默看门狗
  _attachReadyHandler(state);

  // 登录检测 + 未登录降级到 worker partition（对齐 051 subagent-runner.js L765-855）。
  // 不 await：与 resultPromise 并行——已登录即静默继续；未登录则重建子窗口（worker partition）。
  void _checkLoginAndFallback(state);

  try {
    return await resultPromise;
  } finally {
    // 兜底清理（正常路径已在 completed/failed 内清过）
    if (activeTasks.has(taskId)) {
      _clearTaskTimers(state);
      activeTasks.delete(taskId);
      _notifyStatusChange();
    }
    // 关闭子代理窗口（登录降级后 state.win 指向新窗口；此处按 state 而非常量 windowId，
    // 保证降级重建的窗口也能在收尾时关闭）
    if (parentProfileId) decRunning(parentProfileId);
    try {
      if (state.win && !state.win.isDestroyed()) state.win.close();
    } catch (_) { /* ignore */ }
    // 通知父窗口刷新工作区列表（子代理的会话/血缘已写入账本）
    try {
      const parentCtx = windowState.getWindowContext(opts.parentWindowId);
      if (parentCtx && parentCtx.win && !parentCtx.win.isDestroyed()) {
        parentCtx.win.webContents.send('shell-sessions-changed');
      }
    } catch (_) { /* ignore */ }
  }
}
