/**
 * DeepSeek 拦截模式下的回复处理器（隔离世界）
 * 监听主世界注入的 'cuckoo-ai-response' 事件，收到完整回复后走与 DOM 模式
 * 相同的工具调用/JS 代码块处理流程。
 */
import { extractJsToolBlocks, countAwaitCalls, BT } from '../parser/js-detector.js';
import { looksLikeJsonToolCall } from '../parser/json-detector.js';
import { handleJsToolScript } from '../loop/executor.js';
import { sendCombinedJsResultsToChat, sendMessageToChat, cancelPendingSend } from '../../overlay/chat-input.js';
import { showToolMask, hideToolMask } from '../../overlay/panel.js';
import * as watchdog from '../loop/watchdog.js';

const MAX_JS_RETRY = 3;
// 子 Agent 单次回复允许的 cuckoo 代码块上限（超过整轮不执行）
const MAX_JS_BLOCKS_PER_REPLY = 3;
// 子 Agent 单个代码块内允许的工具调用数上限（超过整轮不执行）
const MAX_TOOLS_PER_BLOCK = 3;
// 是否子代理窗口（由 bridge/subagent 在激活时置位）——门禁仅对子代理生效
let isSubagentActive = false;
/** 设置"当前窗口是否为子代理"标识（供子代理工具调用门禁判定） */
function setSubagentActive(v: boolean): void { isSubagentActive = !!v; }
// 连续"格式提示"次数（JSON/XML 共用，防止 AI 来回切换格式绕过上限）
let formatHintCount = 0;
const FORMAT_HINT_MAX = 10;
// 上次已处理的文本（去重，防同一条回复重复处理）
let lastProcessedText = '';
// 最近一次拦截到的完整回复文本（供手动解析复用，不依赖 DOM）
let lastInterceptedText = '';
// 用户请求中止：停止工具循环的回传（停止按钮触发）
let abortRequested = false;
function requestAbort(): void { abortRequested = true; }
function clearAbort(): void { abortRequested = false; }

function looksLikeIncompleteCodeError(error: any): boolean {
  if (!error || typeof error !== 'string') return false;
  return /SyntaxError|Missing initializer|Unexpected end of input|Unexpected token|Unexpected identifier|Unexpected reserved word|Invalid or unexpected token/i.test(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行 JS 代码块，遇到"代码不完整"错误时自动重试。
 * 拦截模式下文本已完整（finished），无需重新提取，简单重试执行即可。
 * @param shouldCancel 取消判定；返回 true 时停止执行后续代码块（已进入执行的块不中断）
 * @returns 已执行块的结果（取消时为已完成的那些块）
 */
async function executeJsBlocksWithRetry(blocks: string[], shouldCancel?: () => boolean): Promise<any[]> {
  // 工具开始（每个代码块一次）
  for (const code of blocks) emitToolCall({ phase: 'start', code });
  let results: any[] = [];
  for (let attempt = 0; attempt <= MAX_JS_RETRY; attempt++) {
    results = [];
    for (const code of blocks) {
      // 用户已取消：不再执行后续代码块，仅保留已执行块的结果
      // ponytail: 已进入 handleJsToolScript 的块无法中断（长任务如 runAgent 需等其返回）；
      //   升级路径 = 把 AbortSignal 贯穿 handleJsToolScript → electronAPI.executeJs → runAgent
      if (shouldCancel && shouldCancel()) break;
      const r = await handleJsToolScript(code);
      if (r) results.push(r);
    }
    if (shouldCancel && shouldCancel()) break;
    const hasIncompleteFailure = results.some(
      (item) => item && item.result && !item.result.success && looksLikeIncompleteCodeError(item.result.error)
    );
    if (!hasIncompleteFailure) break;
    if (attempt < MAX_JS_RETRY) await sleep(1000);
  }
  // 工具结束（逐块上报结果）
  for (const r of results) {
    emitToolCall({
      phase: 'end',
      code: (r && r.code) || '',
      success: !!(r && r.result && r.result.success),
      output: (r && r.result && r.result.output) || '',
      error: (r && r.result && r.result.error) || '',
    });
  }
  return results;
}

/**
 * 构造"超限提示"中的调整建议（两种门禁共用尾部，首/次条按被违反的门禁各自突出约束）。
 * @param kind 'blocks'=块数超限（突出代码块数）；'calls'=单块调用数超限（突出单块调用数，对齐 0.5.1 L194-195）
 */
function buildSubagentAdjustAdvice(kind: 'blocks' | 'calls'): string {
  const F = BT + BT + BT;
  const NL = String.fromCharCode(10);
  const first = kind === 'calls'
    ? '- 单个代码块最多 ' + MAX_TOOLS_PER_BLOCK + ' 个工具调用'
    : '- 一次回复最多 ' + MAX_JS_BLOCKS_PER_REPLY + ' 个代码块，每个代码块最多 ' + MAX_TOOLS_PER_BLOCK + ' 个工具调用';
  const second = kind === 'calls'
    ? '- 一次回复最多 ' + MAX_JS_BLOCKS_PER_REPLY + ' 个代码块，步骤多就分成多轮对话'
    : '- 步骤多就分成多轮对话，多几轮没有关系';
  return '请调整后重新发送：' + NL
    + first + NL
    + second + NL
    + '- 每个工具调用的结果都会发回给你，结果越大越耗上下文：大结果留在块内变量处理，只 log 必要信息' + NL
    + NL
    + '正确示例（单块 3 个调用）：' + NL
    + '    const a = await read("fileA");' + NL
    + '    const b = await grep("TODO", a);' + NL
    + '    log("命中行数: " + b.length);' + NL
    + NL
    + '（工具调用请使用 ' + F + 'cuckoo' + F + ' 代码块）';
}

/** 子代理工具调用门禁判定结果（判别联合，消除调用方的非空断言） */
type SubagentGateResult =
  | { allowed: true }
  | { allowed: false; reason: string; tag: string; hint: string };

/**
 * 子代理工具调用门禁：块数超限 / 单块调用数超限 → 整轮不执行。
 * 仅对子代理窗口生效（主窗口直接放行）。
 * @param jsBlocks 本轮提取到的 JS 工具代码块
 * @returns 判别联合；allowed=false 时 reason/tag/hint 必然存在
 */
function checkSubagentBlockLimits(jsBlocks: string[]): SubagentGateResult {
  if (!isSubagentActive) return { allowed: true };
  const NL = String.fromCharCode(10);
  // 块数门禁：> MAX_JS_BLOCKS_PER_REPLY 块整轮不执行
  if (jsBlocks.length > MAX_JS_BLOCKS_PER_REPLY) {
    const hint = '你本次回复包含 ' + jsBlocks.length + ' 个代码块，超过单次上限 ' + MAX_JS_BLOCKS_PER_REPLY + ' 个，本轮未执行任何工具。' + NL + NL
      + buildSubagentAdjustAdvice('blocks');
    return { allowed: false, reason: '子 Agent 回复块数超限（' + jsBlocks.length + ' > ' + MAX_JS_BLOCKS_PER_REPLY + '）', tag: '块数超限提示', hint };
  }
  // 单块调用数门禁：任一块内工具调用 > MAX_TOOLS_PER_BLOCK 整轮不执行
  // detail 为空串即无超限块（省去中间数组），非空即可直接用于提示
  const detail = jsBlocks
    .map((code, i) => ({ index: i + 1, count: countAwaitCalls(code) }))
    .filter((b) => b.count > MAX_TOOLS_PER_BLOCK)
    .map((b) => '第 ' + b.index + ' 个代码块：' + b.count + ' 个调用')
    .join('；');
  if (detail) {
    const hint = '你本次回复的代码块内工具调用数量过多（' + detail + '），超过单块上限 ' + MAX_TOOLS_PER_BLOCK + ' 个，本轮未执行任何工具。' + NL + NL
      + buildSubagentAdjustAdvice('calls');
    return { allowed: false, reason: '子 Agent 单块调用数超限（' + detail + '）', tag: '单块调用数超限提示', hint };
  }
  return { allowed: true };
}

/**
 * 处理一条已完成的 AI 回复文本
 * @param text 完整回复文本（Markdown 原文）
 * @param force 为 true 时跳过去重（手动解析重新执行同一条时使用）
 */
async function processInterceptedResponse(text: string, force?: boolean): Promise<void> {
  if (abortRequested) { abortRequested = false; console.log('[Cuckoo Code][拦截] 已请求中止，跳过本次处理'); return; }
  const raw = (text || '').trim();
  if (!raw) return;
  if (!force && raw === lastProcessedText) return;
  lastProcessedText = raw;

  console.log('[Cuckoo Code][拦截] 收到完整回复，长度=' + raw.length + '，开始解析工具调用');

  // 1. 优先检测 JS 工具代码块（cuckoo / js 代码块）
  const jsBlocks = extractJsToolBlocks(raw);
  if (jsBlocks.length > 0) {
    const gate = checkSubagentBlockLimits(jsBlocks);
    if (!gate.allowed) {
      console.log('[Cuckoo Code][拦截] ' + gate.reason + '，本轮不执行工具块');
      sendMessageToChat(gate.hint, gate.tag);
      return;
    }
    console.log('[Cuckoo Code][拦截] 检测到 JS 工具代码块（' + jsBlocks.length + ' 个），开始执行');
    formatHintCount = 0;
    // 从检测到工具调用到结果发送完成，全程遮盖页面，禁止用户额外操作；
    // 工具执行期间同样显示「停止」按钮（子代理长任务需要可取消）
    let cancelled = false;
    const onCancel = () => {
      cancelled = true;
      cancelPendingSend();
      hideToolMask();
    };
    showToolMask(onCancel);
    let results: any[] = [];
    try {
      results = await executeJsBlocksWithRetry(jsBlocks, () => cancelled);
    } catch (err) {
      hideToolMask();
      throw err;
    }
    // 用户已取消：丢弃执行结果，不再回传
    if (cancelled) {
      hideToolMask();
      return;
    }
    if (results.length === 0) {
      hideToolMask();
      return;
    }
    // 等待发送阶段：遮罩保持「停止」按钮（onCancel 复用，避免重复声明 cancelled），点击可取消回传
    showToolMask(onCancel);
    // 0.8.11：中途收到中止请求 → 不回传工具结果
    if (abortRequested) { abortRequested = false; hideToolMask(); console.log('[Cuckoo Code][拦截] 已请求中止，不回传工具结果'); return; }
    // afterSent 在"结果已发出"时触发隐藏；发送失败（找不到输入框等）则立即隐藏兜底
    const sent = await sendCombinedJsResultsToChat(results, hideToolMask);
    if (cancelled) return; // 用户已取消，不再处理
    if (!sent) hideToolMask();
    return;
  }

  // 2. JSON 格式工具调用（D11：已废除执行，仅识别并提示改用 cuckoo 代码块）
  if (looksLikeJsonToolCall(raw)) {
    if (formatHintCount >= FORMAT_HINT_MAX) {
      console.log('[Cuckoo Code][拦截] 已连续提示 ' + formatHintCount + ' 次格式问题，停止发送');
      return;
    }
    formatHintCount++;
    console.log('[Cuckoo Code][拦截] 检测到 JSON 格式工具调用（第 ' + formatHintCount + ' 次提示）');
    sendMessageToChat(
      '请使用' + BT + BT + BT + 'cuckoo' + BT + BT + BT + ' 代码块进行工具调用，不要输出 JSON 格式。',
      'JSON工具调用提示'
    );
    return;
  }

  // 3. XML 格式工具调用提示
  const hasAntmlXml = /^<\s*｜｜DSML｜｜/i.test(raw);
  const hasXmlInvoke = /<\s*(?:[\w-]+:)?invoke\s+name=/i.test(raw);
  const hasXmlClose = /<\s*\/\s*(?:[\w-]+:)?invoke\s*>/i.test(raw);
  const hasXmlParam = /<\s*(?:[\w-]+:)?parameter\s+name=/i.test(raw);
  if (hasAntmlXml || (hasXmlInvoke && (hasXmlClose || hasXmlParam))) {
    if (formatHintCount >= FORMAT_HINT_MAX) {
      console.log('[Cuckoo Code][拦截] 已连续提示 ' + formatHintCount + ' 次格式问题，停止发送');
      return;
    }
    formatHintCount++;
    console.log('[Cuckoo Code][拦截] 检测到 XML 格式工具调用（第 ' + formatHintCount + ' 次提示）');
    sendMessageToChat(
      '请使用' + BT + BT + BT + 'cuckoo' + BT + BT + BT + ' 代码块进行工具调用，不要使用 XML invoke 格式。',
      'XML工具调用提示'
    );
    return;
  }

  // 4. 普通文本回复：任务完成，退出工具循环
  console.log('[Cuckoo Code][拦截] 正常文本回复，未检测到工具调用');
  try {
    (window as any).electronAPI.showAiNotification().catch(() => {});
  } catch (e) { /* ignore */ }
  // 任务空闲信号（工具循环结束 = AI 给出普通文本回复）——供自动压缩等"任务边界"逻辑使用
  emitTaskIdle();
}

// 流式增量监听器（供纯净模式实时渲染；无监听者时零开销）
const streamListeners = new Set<(ev: any) => void>();

/** 注册"流式增量"监听器（{ think, text, finished }） */
function onStream(cb: (ev: any) => void): () => void {
  streamListeners.add(cb);
  return () => streamListeners.delete(cb);
}

/** 派发流式增量（无监听者时直接返回） */
function emitStream(ev: any): void {
  if (streamListeners.size === 0) return;
  for (const cb of streamListeners) {
    try { cb(ev); } catch (_) { /* ignore */ }
  }
}

// 任务空闲监听器（工具循环结束：AI 给出普通文本回复时派发；无监听者时零开销）
const taskIdleListeners = new Set<() => void>();

/** 注册"任务空闲"监听器（工具循环结束） */
function onTaskIdle(cb: () => void): () => void {
  taskIdleListeners.add(cb);
  return () => taskIdleListeners.delete(cb);
}

/** 派发"任务空闲"（无监听者时直接返回） */
function emitTaskIdle(): void {
  if (taskIdleListeners.size === 0) return;
  for (const cb of taskIdleListeners) {
    try { cb(); } catch (_) { /* ignore */ }
  }
}

// 工具调用监听器（供纯净模式等上报工具开始/结束；无监听者时零开销）
const toolCallListeners = new Set<(ev: any) => void>();

/**
 * 注册"工具调用"监听器
 * @param cb 工具开始/结束时调用，参数 { phase: 'start'|'end', code, success?, output?, error? }
 * @returns 取消注册
 */
function onToolCall(cb: (ev: any) => void): () => void {
  toolCallListeners.add(cb);
  return () => toolCallListeners.delete(cb);
}

/** 派发工具调用事件（无监听者时直接返回） */
function emitToolCall(ev: any): void {
  if (toolCallListeners.size === 0) return;
  for (const cb of toolCallListeners) {
    try { cb(ev); } catch (_) { /* ignore */ }
  }
}

// 回复完成监听器（供压缩等流程等待 AI 回复完成）
// meta 携带服务端权威数据（tokenUsage / msgIds），由监听方按需取用，
// 避免共享状态跨层（bridge 不依赖 overlay）。
const responseListeners = new Set<(text: string, meta: any) => void>();
// 失败监听器（供自动重试引擎订阅）
const errorListeners = new Set<(detail: any) => void>();

/**
 * 注册"AI 回复完成"监听器
 * @param cb 收到完成回复时调用，参数为完整文本 + meta（{ tokenUsage, msgIds }）
 * @returns 取消注册
 */
function onInterceptedResponse(cb: (text: string, meta: any) => void): () => void {
  responseListeners.add(cb);
  return () => responseListeners.delete(cb);
}

/**
 * 注册"AI 请求失败"监听器
 * @param cb 收到失败事件时调用，参数为 detail { text, status, reason, httpStatus, name }
 * @returns 取消注册
 */
function onAiError(cb: (detail: any) => void): () => void {
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

/**
 * 启动拦截事件监听
 */
function startInterceptObserver(): void {
  window.addEventListener('cuckoo-ai-response', (ev: any) => {
    try {
      const detail = ev && ev.detail;
      if (!detail) return;
      // 诊断日志已移除（高频 JSON.stringify + 每回复输出，会拖慢页面/累积日志）
      // 用户主动停止：不处理，也不通知监听器（等待方按超时处理）
      if (detail.status === 'stopped') {
        console.log('[Cuckoo Code][拦截] 检测到用户停止生成，忽略该回复');
        try { watchdog.onResponseReceived('stopped'); } catch (_) { /* ignore */ }
        return;
      }
      if (!detail.finished) return;
      try { watchdog.onResponseReceived('finished'); } catch (_) { /* ignore */ }
      // 缓存最近一次完整回复文本，供手动解析复用（不依赖 DOM）
      lastInterceptedText = detail.text || '';
      // 通知监听器（每次成功回复都触发），携带服务端权威数据
      const meta = { tokenUsage: detail.tokenUsage || null, msgIds: detail.msgIds || null };
      for (const cb of responseListeners) {
        try { cb(detail.text || '', meta); } catch (_) { /* ignore */ }
      }
      processInterceptedResponse(detail.text);
    } catch (err) {
      console.error('[Cuckoo Code][拦截] 处理回复事件出错:', err);
    }
  });
  window.addEventListener('cuckoo-ai-stream', (ev: any) => {
    try {
      const detail = ev && ev.detail;
      if (!detail) return;
      emitStream({
        think: detail.think || '',
        text: detail.text || '',
        finished: !!detail.finished,
        // 透传服务端权威 token（DeepSeek）；缺失时为 undefined，下游回退估算
        accumulatedTokens: typeof detail.accumulatedTokens === 'number' ? detail.accumulatedTokens : null,
      });
    } catch (_) { /* ignore */ }
  });
  window.addEventListener('cuckoo-ai-error', (ev: any) => {
    try {
      const detail = ev && ev.detail;
      try { watchdog.onResponseReceived('error'); } catch (_) { /* ignore */ }
      for (const cb of errorListeners) {
        try { cb(detail || {}); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      console.error('[Cuckoo Code][拦截] 处理失败事件出错:', err);
    }
  });
  console.log('[Cuckoo Code][拦截] 已启动 cuckoo-ai-response / cuckoo-ai-error 事件监听');
}

/** 取最近一次拦截到的完整回复文本（手动解析用） */
function getLastInterceptedText(): string {
  return lastInterceptedText;
}

export { startInterceptObserver, processInterceptedResponse, getLastInterceptedText, onInterceptedResponse, onAiError, onToolCall, onStream, onTaskIdle, setSubagentActive, requestAbort, clearAbort };
