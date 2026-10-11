/**
 * IPC：执行工具与 JS 脚本
 */
import { createRequire } from 'node:module';
import * as windowState from '../window.js';
import { registry as toolRegistry, jsRunner } from '../../tools/index.js';
import { findTaskByWebContents, markActivity } from '../subagent.js';

const require = createRequire(import.meta.url);
const { ipcMain } = require('electron');

// 上次推送的 todoWrite 列表（去重）
let lastTodosJson = '';

/** 重置计划（新任务/新对话时调用，避免旧 todo 残留） */
function resetTodosCache(): void {
  lastTodosJson = '';
  (globalThis as any).__cuckooTodos = [];
}

export { resetTodosCache };

function registerToolIpc(): void {
  // 执行工具
  ipcMain.handle('execute-tool', async (event: any, { toolName, params, callId }: any) => {
    // T2b：子代理活动信号 + force_deliver 后工具门禁（普通窗口 markActivity 返回 false 但不拦截）
    const subState = findTaskByWebContents(event.sender);
    if (subState && !markActivity(subState)) {
      return { callId, success: false, error: '已达到轮次上限，请输出 subagent_result 交付结果' };
    }
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    const win = ctx ? ctx.win : null;
    const windowId = win && !win.isDestroyed() ? win.id : null;
    try {
      const result = await toolRegistry.execute(toolName, { ...params, projectDir: selectedDir, currentWindowId: windowId });
      return { callId, success: result.success, data: result.data, error: result.error };
    } catch (err: any) {
      return { callId, success: false, error: err.message };
    }
  });

  // 执行 JS 脚本
  ipcMain.handle('execute-js', async (event: any, { code, callId, attachDelayMin, attachDelayMax, ssrfGuard }: any) => {
    if (!code || typeof code !== 'string') {
      return { callId, success: false, error: '无效的 JS 代码' };
    }
    // T2b：子代理活动信号 + force_deliver 后工具门禁
    const subState = findTaskByWebContents(event.sender);
    if (subState && !markActivity(subState)) {
      return { callId, success: false, error: '已达到轮次上限，请输出 subagent_result 交付结果' };
    }
    const ctx = windowState.getContextByWebContents(event.sender);
    const store = ctx ? ctx.sessionStore : null;
    const selectedDir = store ? store.state.selectedProjectDir : null;
    const sessionId = store ? store.state.currentSessionId : null;
    const win = ctx ? ctx.win : null;
    const windowId = win && !win.isDestroyed() ? win.id : null;
    try {
      const result = await jsRunner.run(code, selectedDir, windowId, { attachDelayMin, attachDelayMax, sessionId, ssrfGuard });
      // 复用官方 todoWrite 结果：执行后读取 globalThis.__cuckooTodos（官方规范化的列表），推给 harness
      try {
        const todos = (globalThis as any).__cuckooTodos;
        if (Array.isArray(todos) && todos.length) {
          const json = JSON.stringify(todos);
          if (json !== lastTodosJson) {
            lastTodosJson = json;
            const hv = ctx && (ctx as any).harnessView;
            if (hv && !hv.webContents.isDestroyed()) {
              hv.webContents.send('harness-event', { type: 'plan', todos: todos });
            }
          }
        }
      } catch (_) { /* ignore */ }
      return { callId, ...result };
    } catch (err: any) {
      return { callId, success: false, error: err.message };
    }
  });
}

export { registerToolIpc };
