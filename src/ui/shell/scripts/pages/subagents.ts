/**
 * 运行中子代理列表（融合进「子代理」页，不再单独占一个侧栏标签）。
 *
 * 从 086 的 shell.html 单体内联脚本迁移而来（0.8.11 起壳页面改由
 * src/ui/shell/ 分片生成，内联脚本会被 scripts/build-shell.mjs 覆盖）。
 *
 * T10 二次修复（m1/TD1）：状态由主进程 push（onSubagentStatus 订阅），
 * 渲染侧不再 setInterval 轮询。进入 tab 拉一次初始状态；此后主进程有任务即推、
 * 无任务即停（进入/离开 tab 无需启停轮询）。
 *
 * 页面结构（partials/pages/agents.html）：
 *   #sa-running-block（默认 display:none）内含 #subagent-list —— 有任务才显示
 *   #agent-list —— 代理定义列表（由 pages/agents.ts 负责）
 */
import { api, ckConfirm, escapeHtml } from '../shared.js';

/** 上次渲染的数据签名（m2：无变化跳过 innerHTML 重建） */
let lastSubagentSig: string | null = null;

/** 已耗时毫秒 → mm:ss（对齐 051 overlay/events.js「formatElapsed」） */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor((ms || 0) / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return m + ':' + s;
}

/** 有任务才显示「运行中」分组（无任务整块隐藏，避免空标题占位） */
function setRunningVisible(visible: boolean): void {
  const block = document.getElementById('sa-running-block');
  if (block) block.style.display = visible ? '' : 'none';
}

/**
 * 渲染运行中子代理列表。
 * m2：先算签名（taskId + agentType + provider + windowId），与上次相同则跳过重建，
 * 避免每秒 innerHTML 全量重建打断 hover/focus。
 * 注意：签名不含 elapsedMs（每秒都变），仅当任务增删/属性变化时才重建；
 * 已耗时的每秒刷新交给 updateSubagentElapsed（只改文本，不重建 DOM）。
 */
export function renderSubagentTasks(tasks: any[]): void {
  const listEl = document.getElementById('subagent-list');
  if (!listEl) return;
  tasks = tasks || [];
  setRunningVisible(tasks.length > 0);
  const sig = tasks.map((t: any) => t.taskId + '|' + (t.agentType || '') + '|' + (t.provider || '') + '|' + t.windowId).join(',');
  if (sig === lastSubagentSig) {
    updateSubagentElapsed(tasks);
    return;
  }
  lastSubagentSig = sig;
  if (tasks.length === 0) {
    listEl.innerHTML = '';
    return;
  }
  listEl.innerHTML = tasks.map((t: any) =>
    '<div class="ck-list-item ck-sa-item">' +
      '<div class="ck-sa-top">' +
        '<span class="ck-sa-name">' + escapeHtml(t.agentType || '通用') + '</span>' +
        '<span class="ck-sa-provider">' + escapeHtml(t.provider || '-') + '</span>' +
        '<span class="ck-sa-elapsed">' + formatElapsed(t.elapsedMs) + '</span>' +
      '</div>' +
      '<div class="ck-sa-actions">' +
        '<button class="ck-mini-btn" data-act="focus" data-window-id="' + t.windowId + '">切换</button>' +
        '<button class="ck-mini-btn ck-mini-danger" data-act="abort" data-window-id="' + t.windowId + '">中止</button>' +
      '</div>' +
    '</div>'
  ).join('');

  listEl.querySelectorAll('button[data-act]').forEach((btn: any) => {
    btn.addEventListener('click', async (e: any) => {
      e.stopPropagation();
      const wid = Number(btn.dataset.windowId);
      if (btn.dataset.act === 'focus') {
        try { if (api.focusSubagentWindow) await api.focusSubagentWindow(wid); } catch (_) { /* ignore */ }
        return;
      }
      // 中止为破坏性操作：先二次确认，再执行；主进程会随之推新状态（无需手动刷）
      if (!(await ckConfirm('确定中止该子代理任务？'))) return;
      try { if (api.subagentAbort) await api.subagentAbort(wid); } catch (_) { /* ignore */ }
    });
  });
}

/**
 * m2：数据无变化时只更新已耗时文本（保留 hover/focus，不重建 DOM）。
 * 按 data-window-id 匹配列表项中的 .ck-sa-elapsed 并写新值。
 */
export function updateSubagentElapsed(tasks: any[]): void {
  const listEl = document.getElementById('subagent-list');
  if (!listEl) return;
  const map: Record<string, number> = {};
  (tasks || []).forEach((t: any) => { map[t.windowId] = t.elapsedMs; });
  listEl.querySelectorAll('.ck-sa-item').forEach((item: any) => {
    const btn = item.querySelector('button[data-act]');
    if (!btn) return;
    const wid = Number(btn.dataset.windowId);
    const el = item.querySelector('.ck-sa-elapsed');
    if (el && map[wid] != null) el.textContent = formatElapsed(map[wid]);
  });
}

/** 从主进程拉一次状态并渲染（进入 tab / 手动刷新用；不用作轮询） */
export async function loadSubagents(): Promise<void> {
  if (!api.getSubagentStatus) return;
  let tasks: any[] = [];
  try {
    const r = await api.getSubagentStatus();
    if (r && r.success) tasks = r.tasks || [];
  } catch (_) { /* ignore */ }
  renderSubagentTasks(tasks);
}

/** 订阅主进程 push（有任务即推、无任务即停）+ 绑定刷新按钮 */
export function initSubagents(): void {
  if (api.onSubagentStatus) {
    api.onSubagentStatus((data: any) => renderSubagentTasks((data && data.tasks) || []));
  }
  // 页面上的刷新按钮是 agents 页共用的 #agent-refresh（见 pages/agents.ts），
  // 这里再挂一个「运行中」刷新：点击时同时刷新区块（agents.ts 已负责代理定义列表）。
  const saRefreshBtn = document.getElementById('sa-refresh');
  if (saRefreshBtn) saRefreshBtn.addEventListener('click', () => { void loadSubagents(); });
}
