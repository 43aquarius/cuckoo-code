/**
 * Profile 管理模块
 * 每个 profile 对应一个独立的 partition，实现类似 Chrome 的多用户隔离。
 * profile 列表持久化在 userData/profile-list.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app } = require('electron');

let PROFILE_FILE: string | null = null;
let LAST_ACTIVE_FILE: string | null = null;

function getProfileFile(): string {
  if (!PROFILE_FILE) {
    PROFILE_FILE = path.join(app.getPath('userData'), 'profile-list.json');
  }
  return PROFILE_FILE;
}

function getLastActiveFile(): string {
  if (!LAST_ACTIVE_FILE) {
    LAST_ACTIVE_FILE = path.join(app.getPath('userData'), 'last-active-profile.json');
  }
  return LAST_ACTIVE_FILE;
}

/** 记录最后活跃的 profileId（窗口获得焦点时调用） */
function setLastActiveProfileId(id: string): void {
  if (!id) return;
  try {
    const file = getLastActiveFile();
    // 去重：内容没变就不写盘
    if (fs.existsSync(file)) {
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (cur && cur.profileId === id) return;
      } catch (_) { /* ignore */ }
    }
    fs.writeFileSync(file, JSON.stringify({ profileId: id }, null, 2), 'utf-8');
  } catch (err: any) {
    console.error('[Profile] 写入 last-active 失败:', err.message);
  }
}

/** 读取最后活跃的 profileId（无则 null） */
function getLastActiveProfileId(): string | null {
  try {
    const file = getLastActiveFile();
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (data && data.profileId) || null;
  } catch (_) {
    return null;
  }
}

function readProfiles(): any[] {
  try {
    const file = getProfileFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err: any) {
    console.error('[Profile] 读取 profile 列表失败:', err.message);
  }
  return [];
}

function writeProfiles(profiles: any[]): void {
  try {
    const file = getProfileFile();
    fs.writeFileSync(file, JSON.stringify(profiles, null, 2), 'utf-8');
  } catch (err: any) {
    console.error('[Profile] 写入 profile 列表失败:', err.message);
  }
}

/**
 * 创建新 profile
 * @param name 显示名称
 * @param providerId 平台 id（默认 deepseek）
 */
function createProfile(name: string, providerId: string): any {
  const profiles = readProfiles();
  // providerId 为空表示平台未确定，首次打开会显示平台选择页
  const pid = providerId || '';
  const id = 'profile-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const profile = {
    id,
    providerId: pid,
    name: name || ('窗口' + (profiles.length + 1)),
    partition: 'persist:' + (pid ? pid + ':' : '') + id,
    createdAt: new Date().toISOString(),
    autoOpen: false,
    feishuChatId: '',
    feishuChatName: '',
  };
  profiles.push(profile);
  writeProfiles(profiles);
  console.log('[Profile] 已创建:', profile.id, profile.name, 'provider=' + (pid || '(未确定)'));
  return profile;
}

/**
 * 获取默认 profile，若不存在则创建
 */
function getDefaultProfile(): any {
  const profiles = readProfiles();
  if (profiles.length === 0) return createProfile('默认窗口', '');
  // 优先返回上次最后活跃的 profile（若仍存在），否则回退第一个
  const lastId = getLastActiveProfileId();
  if (lastId) {
    const p = profiles.find(x => x.id === lastId);
    if (p) return p;
  }
  return profiles[0];
}

/**
 * 根据 id 获取 profile
 */
function getProfileById(id: string): any {
  return readProfiles().find(p => p.id === id) || null;
}

/**
 * 删除 profile
 */
function deleteProfile(id: string): boolean {
  const profiles = readProfiles();
  const idx = profiles.findIndex(p => p.id === id);
  if (idx === -1) return false;
  profiles.splice(idx, 1);
  writeProfiles(profiles);
  return true;
}

/**
 * 更新 profile 平台
 */
function updateProfileProvider(id: string, providerId: string): any {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p || !providerId) return null;
  p.providerId = providerId;
  p.partition = 'persist:' + providerId + ':' + id;
  writeProfiles(profiles);
  return p;
}

/**
 * 创建子代理窗口的临时 profile。
 * 关键：partition 复用【选定的池账号】的（独立 partition + 免登录），
 * 与主账号分离，避免同账号并发触发平台限流（429）。
 * 该 profile 不写入 profile-list.json（窗口关闭即弃）。
 * @param account 选定的池账号 profile（决定 partition / providerId）
 * @param agentName 代理名（窗口标题用）
 */
function createSubagentProfile(account: any, agentName: string): any {
  if (!account) throw new Error('createSubagentProfile: account 不能为空');
  return {
    id: 'subagent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    providerId: account.providerId,
    name: '子代理: ' + (agentName || 'agent'),
    partition: account.partition, // 复用池账号 partition（独立于主账号）
    isSubagent: true,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 清理子代理窗口遗留的 session 存储文件（历史 bug：子代理不需要持久化，
 * 但旧版本每个子代理都写了一个 session-dir-map-subagent-*.json）。
 */
function cleanupSubagentStores(): void {
  try {
    const dir = app.getPath('userData');
    const files = fs.readdirSync(dir);
    let n = 0;
    for (const f of files) {
      if (f.startsWith('session-dir-map-subagent-') && f.endsWith('.json')) {
        try { fs.unlinkSync(path.join(dir, f)); n++; } catch (_) { /* ignore */ }
      }
    }
    if (n > 0) console.log('[Profile] 已清理子代理遗留存储文件:', n, '个');
  } catch (err: any) {
    console.error('[Profile] 清理子代理存储失败:', err.message);
  }
}

/** 设置某 profile 绑定的飞书群（chatId/chatName）；空串表示解绑 */
function setProfileFeishuChat(id: string, chatId: string, chatName: string): any {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return null;
  p.feishuChatId = chatId || '';
  p.feishuChatName = chatName || '';
  writeProfiles(profiles);
  console.log('[Profile] 飞书群绑定更新:', id, chatId ? (chatName + '(' + chatId + ')') : '(解绑)');
  return p;
}

/** 按飞书群 chatId 反查 profile（哪个窗口绑了这个群） */
function getProfileByFeishuChat(chatId: string): any {
  if (!chatId) return null;
  return readProfiles().find(p => p.feishuChatId === chatId) || null;
}

/** 设置某 profile 是否"启动时默认打开" */
function setAutoOpen(id: string, on: boolean): any {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return null;
  p.autoOpen = !!on;
  writeProfiles(profiles);
  return p;
}

/** 记录某 profile 最后访问的 URL（关闭窗口时调用；仅记 http/https） */
function setLastUrl(id: string, url: string): any {
  if (!id || !url || !/^https?:\/\//i.test(url)) return null;
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return null;
  p.lastUrl = url;
  writeProfiles(profiles);
  console.log('[Profile] 已记录 lastUrl:', id, url);
  return p;
}

/** 清除某 profile 的最后 URL（如切换平台时） */
function clearLastUrl(id: string): void {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p || !p.lastUrl) return;
  delete p.lastUrl;
  writeProfiles(profiles);
}

/** 记录某 profile 的窗口大小/位置（关闭窗口时调用） */
function setWindowBounds(id: string, bounds: any): any {
  if (!id || !bounds) return null;
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p) return null;
  p.bounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: !!bounds.maximized,
  };
  writeProfiles(profiles);
  return p;
}

/** 返回所有"启动时默认打开"的 profile */
function getAutoOpenProfiles(): any[] {
  return readProfiles().filter(p => p.autoOpen === true);
}

/**
 * 更新 profile 显示名称
 */
function updateProfileName(id: string, name: string): any {
  const profiles = readProfiles();
  const p = profiles.find(x => x.id === id);
  if (!p || !name || !name.trim()) return null;
  p.name = name.trim();
  writeProfiles(profiles);
  return p;
}

export {
  readProfiles,
  writeProfiles,
  createProfile,
  createSubagentProfile,
  getDefaultProfile,
  getProfileById,
  updateProfileName,
  setProfileFeishuChat,
  getProfileByFeishuChat,
  updateProfileProvider,
  deleteProfile,
  setLastActiveProfileId,
  getLastActiveProfileId,
  setAutoOpen,
  setWindowBounds,
  getAutoOpenProfiles,
  setLastUrl,
  clearLastUrl,
  cleanupSubagentStores,
};
