/**
 * IPC：子代理回复上报
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as windowState from '../window.js';
import {
  onSubagentReady,
  findTaskByWebContents,
  recordRound,
  handleCandidateResult,
  abortByWindowId,
  focusByWindowId,
  getStatusList,
} from '../subagent.js';
import type { SubagentCandidatePayload } from '../subagent.js';
import { scanAgents } from '../../agents/index.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

function registerSubagentIpc(): void {
  // T2b：observer-ready 握手 —— preload 就绪上报 → resolve runner 的 readyPromise
  ipcMain.handle('subagent-ready', async (event: any) => {
    const ok = onSubagentReady(event.sender);
    console.log('[子代理] subagent-ready 握手:', ok ? 'OK' : '未匹配（可能已超时/终止）');
    return { success: ok };
  });

  // T2c：子代理候选结果上报（subagent_result 围栏完成 / plain_text）
  // 按 sender 反查任务，仅 working / force_deliver 阶段接收。
  ipcMain.handle('subagent-candidate-result', async (event: any, payload: SubagentCandidatePayload) => {
    return handleCandidateResult(event.sender, payload);
  });

  // T2b：子代理收到一轮 AI 回复 → 轮次计数 + 重置 silence 计时器（达硬顶转 force_deliver）
  // 顺序约束：本处理器必须先于工具调用门禁被调用（051 L155-165 → L168）；
  // bridge 侧在 responseListeners 回调内触发，早于 observer.processInterceptedResponse 的门禁。
  ipcMain.handle('subagent-round', async (event: any) => {
    const state = findTaskByWebContents(event.sender);
    if (!state) return { success: false };
    const allowed = recordRound(state);
    return { success: true, allowed };
  });

  // 中止子 Agent 任务（按 windowId）。权威源：051 ipc.js L284-288。
  // m-3：窗口 id 恒为 number；字符串 '3' 会通过 !windowId 守卫但严格比较永不命中，故显式校验类型。
  ipcMain.handle('subagent-abort', async (_event: any, { windowId }: any = {}) => {
    if (typeof windowId !== 'number') return { success: false, error: 'windowId 非法' };
    const ok = abortByWindowId(windowId);
    return { success: ok };
  });

  // 聚焦子 Agent 窗口（按 windowId）。权威源：051 ipc.js L268-272。
  ipcMain.handle('focus-subagent-window', async (_event: any, { windowId }: any = {}) => {
    if (typeof windowId !== 'number') return { success: false, error: 'windowId 非法' };
    const ok = focusByWindowId(windowId);
    return { success: ok };
  });

  // 获取运行中子代理任务状态列表（壳侧边栏「子代理」面板轮询用）。
  ipcMain.handle('get-subagent-status', async () => {
    try {
      return { success: true, tasks: getStatusList() };
    } catch (err: any) {
      return { success: false, error: err && err.message, tasks: [] };
    }
  });

  // 获取可用 agent 模板清单 + 用户 agent 目录（多 Agent 按钮机制说明拼接用）。
  // 权威源：051 ipc.js L260-265（051 getAgentList 扫「内置 + userData 两处」，返回全部可用）。
  // 086 用 scanAgents 替代（无 agent-templates 模块）：扫「当前窗项目级 + 用户级」两处，
  // m-2：传 null 只扫用户级、漏项目级 <projectDir>/.cuckoo/agents → 由当前窗 sessionStore 取 projectDir。
  // agentDir 回落用户级目录 ~/.cuckoo/agents（scanAgents 扫描的用户作用域）。
  ipcMain.handle('get-agent-list', async (event: any) => {
    try {
      const ctx = windowState.getContextByWebContents(event && event.sender);
      const store = ctx ? ctx.sessionStore : null;
      const projectDir = (store && store.state && store.state.selectedProjectDir) || null;
      const agents = scanAgents(projectDir).map((a: any) => ({ id: a.name, summary: a.description || '' }));
      return { success: true, agents, agentDir: path.join(os.homedir(), '.cuckoo', 'agents') };
    } catch (err: any) {
      return { success: false, error: err && err.message };
    }
  });
}

export { registerSubagentIpc };
