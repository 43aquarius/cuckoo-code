/**
 * 全局发送延迟（sendDelay）中心化存储 + IPC。
 *
 * 背景：086 设置以「AI 页面 localStorage」为真源，主窗与子窗 partition 不同（子窗用池账号 partition），
 * localStorage 不共享 → 子窗 randomDelay 读不到主窗设置（退化为默认 2-4s，易触发 429 限流）。
 * 本模块把 sendDelay 中心化到主进程（主窗保存/恢复默认时同步；子窗启动时取；变更时广播），落盘 userData/send-delay.json。
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as windowState from '../window.js';

const require = createRequire(import.meta.url);
const { ipcMain, app } = require('electron');

/** 全局 sendDelay（内存缓存） */
let globalSendDelay: { min: number; max: number } | null = null;

function stateFile(): string {
  return path.join(app.getPath('userData'), 'send-delay.json');
}

/** 读盘（惰性；失败或值非法返回 null） */
function loadFromDisk(): { min: number; max: number } | null {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && Number.isFinite(obj.min) && Number.isFinite(obj.max) && obj.min >= 0 && obj.max >= obj.min) {
      return { min: obj.min, max: obj.max };
    }
  } catch (_) { /* 文件不存在/非法 → null */ }
  return null;
}

/** 取全局 sendDelay（内存 → 盘 → null） */
function getGlobalSendDelay(): { min: number; max: number } | null {
  if (!globalSendDelay) globalSendDelay = loadFromDisk();
  return globalSendDelay;
}

/** 向所有窗口广播 sendDelay 变更（供已开子窗实时更新） */
function broadcastSendDelay(min: number, max: number): void {
  try {
    for (const win of windowState.getAllWindows()) {
      try { win.webContents.send('send-delay-changed', { min, max }); } catch (_) { /* 窗口已销毁 */ }
    }
  } catch (_) { /* windowState 不可用 → 忽略 */ }
}

/** 存全局 sendDelay（内存 + 落盘 + 广播；非法值直接忽略） */
function setGlobalSendDelay(min: number, max: number): void {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return;
  globalSendDelay = { min, max };
  try { fs.writeFileSync(stateFile(), JSON.stringify({ min, max }), 'utf-8'); } catch (e) { console.error('[send-delay] 落盘失败:', e); }
  broadcastSendDelay(min, max);
}

function registerSendDelayIpc(): void {
  // 主窗保存/恢复默认时同步（fire-and-forget）
  ipcMain.on('save-global-send-delay', (_e: any, payload: any) => { const { min, max } = payload || {}; setGlobalSendDelay(min, max); });
  // 子窗启动时取（同步返回）
  ipcMain.handle('get-global-send-delay', () => getGlobalSendDelay());
}

export { registerSendDelayIpc };
