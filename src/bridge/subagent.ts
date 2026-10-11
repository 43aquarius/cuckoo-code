/**
 * 子代理窗口的 bridge 逻辑（仅在子代理窗口中激活）
 *
 * 激活条件：主进程经 --cuckoo-subagent-file=<json 文件路径> 传入配置（长配置走文件，避开命令行长度上限）。
 * 流程：页面就绪 → 发任务提示词 → 监听回复 →
 *   - cuckoo 工具块 = 一轮（受 maxTurns 限制）→ IPC 上报 subagent-round
 *   - subagent_result 围栏 = 完成 → IPC 上报 subagent-candidate-result → 主进程 resolve 并关窗
 *   - 纯文本（无围栏、无工具）= plain_text 候选（质量防线归 T2d）
 * 权威源：cuckoo-code-master051/src/preload/dom/intercept-observer.js L147-257。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { extractJsToolBlocks, extractSubagentResultBlocks } from './parser/js-detector.js';
import { buildRoleSection, buildProtocolSection } from './subagent-prompt.js';
import { onInterceptedResponse, setSubagentActive } from './intercept/observer.js';

const require = createRequire(import.meta.url);
const { ipcRenderer } = require('electron');

export interface SubagentConfig {
  agentName: string;
  task: string;
  systemPrompt: string;
  tools: string[] | null;
  maxTurns: number | null;
  projectDir: string | null;
}

/** 从 process.argv 解析子代理配置（无则 null） */
export function readSubagentConfig(): SubagentConfig | null {
  try {
    const argv = (process as any).argv || [];
    // 优先：配置文件路径（【修复 2026-10-03】长配置走文件，避开 Windows 命令行 32767 上限）
    const fileArg = argv.find((a: string) => a.startsWith('--cuckoo-subagent-file='));
    if (fileArg) {
      const file = fileArg.slice('--cuckoo-subagent-file='.length);
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!cfg || !cfg.agentName || !cfg.task) return null;
      return cfg;
    }
    // 兼容：命令行内联（短配置 / 旧路径）
    const arg = argv.find((a: string) => a.startsWith('--cuckoo-subagent='));
    if (!arg) return null;
    const json = decodeURIComponent(arg.slice('--cuckoo-subagent='.length));
    const cfg = JSON.parse(json);
    if (!cfg || !cfg.agentName || !cfg.task) return null;
    return cfg;
  } catch (_) {
    return null;
  }
}

/**
 * 若当前是子代理窗口，则初始化子代理流程。
 * @returns 子代理配置（非子代理窗口返回 null）
 */
export function initSubagentIfNeeded(): SubagentConfig | null {
  const cfg = readSubagentConfig();
  if (!cfg) return null;

  // 供 observer 的工具调用门禁判定 isSubagent。
  // 顺序约束：本函数由 bridge/entry.ts init() 在 startInterceptObserver() 之前同步调用，
  // 置位早于任何回复事件可达时刻，门禁无竞态窗口。调整 init() 顺序或新增 bridge 入口时
  // 必须保持该先后（否则门禁静默 fail-open）。
  setSubagentActive(true);
  console.log('[Cuckoo Code][子代理] 激活：' + cfg.agentName);

  // T2b：observer-ready 握手 —— 通知主进程 resolve runner 的 readyPromise（starting → working）
  // 顺序：须早于 initProject（首条消息）触发，主进程进入 working 后才开始计时 idle/silence。
  ipcRenderer.invoke('subagent-ready').catch(() => {});

  // 监听回复：含工具块 = 一轮（受 maxTurns 限制）；subagent_result 围栏 = 完成；纯文本 = plain_text 候选
  let turnCount = 0;
  onInterceptedResponse((text: string) => {
    const raw = (text || '').trim();
    if (!raw) return;

    // 1. 工具调用块 = 一轮（仅含工具块计轮，对齐 051 intercept-observer.js L148-213）
    // 优先级与 051 一致：先判工具块，后判 subagent_result 围栏。协议虽禁止混合输出，
    // 但模型偶发在同一回复中同时给出工具块与 subagent_result 围栏时，工具块优先执行
    // （051 先 extractJsToolBlocks → 执行；086 对齐之，避免吞掉本该执行的工具轮）。
    // 顺序约束：须在工具门禁之前上报（对齐 051 L155-158 → L168）。本调用位于 responseListener
    // 回调内，早于 observer.processInterceptedResponse 的门禁；被拦轮次（块数超限）仍已计数（m-6 保真）。
    const blocks = extractJsToolBlocks(raw);
    if (blocks.length > 0) {
      ipcRenderer.invoke('subagent-round').catch(() => {});
      turnCount++;
      if (cfg.maxTurns && turnCount >= cfg.maxTurns) {
        console.log('[Cuckoo Code][子代理] 达到 maxTurns=' + cfg.maxTurns + '，停止并上报部分结果');
        ipcRenderer.invoke('subagent-candidate-result', { type: 'subagent_result', text: raw, partial: true, turns: turnCount }).catch(() => {});
      } else {
        console.log('[Cuckoo Code][子代理] 第 ' + turnCount + ' 轮，含 ' + blocks.length + ' 个工具块，继续');
      }
      return;
    }

    // 2. subagent_result 围栏 = 完成（T2c：替代旧「无工具=完成」，对齐 051 intercept-observer.js L215-257）
    const resultBlocks = extractSubagentResultBlocks(raw);
    if (resultBlocks.length > 0) {
      const resultText = resultBlocks.join('\n\n---\n\n');
      console.log('[Cuckoo Code][子代理] 收到 subagent_result，长度=' + resultText.length + '，上报主进程');
      ipcRenderer.invoke('subagent-candidate-result', { type: 'subagent_result', text: resultText }).catch(() => {});
      return;
    }

    // 3. 纯文本（无围栏、无工具）= plain_text 候选（质量防线见 T2d，对齐 051 L1030-1034）
    ipcRenderer.invoke('subagent-candidate-result', { type: 'plain_text', text: raw }).catch(() => {});
  });

  // 复用"初始化项目"流程：调一次 initProject（含工具提示 + 角色段 + 协议段 + 任务）。
  // 首条消息三段式：角色段（prepend）→ base（主窗口工具提示词）→ 协议段（extraPrompt）。
  // isSubagent=true 让 prompt-builder 不注入 CUCKOO.md（避免主编协议污染子代理身份）。
  const prependPrompt = buildRoleSection(cfg.systemPrompt);
  const extraPrompt = buildProtocolSection(cfg.task);
  setTimeout(async () => {
    try {
      await (window as any).electronAPI.initProject(cfg.projectDir || null, false, extraPrompt, true, prependPrompt, true);
      console.log('[Cuckoo Code][子代理] 已调 initProject（复用初始化流程）');
    } catch (e: any) {
      console.error('[Cuckoo Code][子代理] initProject 失败: ' + (e && e.message));
    }
  }, 800);

  return cfg;
}
