/**
 * JS 工具脚本检测与代码块提取
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
// ========== JS 工具脚本检测与执行 ==========

// 反引号与围栏（共享常量，见 infra/markdown）
import { BT, FENCE } from '../../infra/markdown.js';

// 工具调用特征：必须出现 "await 工具函数名(" 形式的调用（防止 fs.readFile 等普通示例误判）
// 注意：本正则（白名单）只用于"是否工具脚本"判定（looksLikeToolScript）；
// 与 countAwaitCalls 的通配正则（任意 await 标识符( ）语义不同，两者独立演进，
// 调整工具名单时勿只改一处——详见 countAwaitCalls 的 JSDoc。
const JS_TOOL_CALL_RE = /\bawait\s+(?:read|readLines|write|edit|glob|grep|todoWrite|bash|pwsh|deleteFile|webFetch|mysql|mcpCall|mcpListServers|mcpGetTools|openBrowserWindow|injectJS|attachFile)\s*\(/;
/**
 * 判断一段 JS 代码是否调用了工具函数
 */
function looksLikeIncompleteCodeError(error: any): boolean {
  if (!error || typeof error !== 'string') return false;
  return /SyntaxError|Missing initializer|Unexpected end of input|Unexpected token|Unexpected identifier|Unexpected reserved word|Invalid or unexpected token/i.test(error);
}

function looksLikeToolScript(code: any): boolean {
  const c = code || '';
  // 1. 内置工具白名单：await write( 等
  if (JS_TOOL_CALL_RE.test(c)) return true;
  // 2. MCP 工具：await mcpXxx(（MCP server 工具名动态，无法进白名单，按 mcp 前缀识别）
  if (/\bawait\s+mcp[A-Za-z_$][\w$]*\s*\(/.test(c)) return true;
  // 3. Cuckoo 输出封装：log(await xxx( ...（log 包裹的任意工具调用，含 MCP）
  if (/\blog\s*\(\s*await\s+[A-Za-z_$][\w$]*\s*\(/.test(c)) return true;
  return false;
}

/**
 * 判断原始文本去掉所有围栏代码块后是否只剩空白（整条回复只包含代码块）
 */
function hasOnlyFences(text: any): boolean {
  if (!text || typeof text !== 'string') return false;
  const lines = text.split(String.fromCharCode(10));
  const rest: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(FENCE)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) rest.push(t);
  }
  return rest.join(' ').trim() === '';
}

/**
 * 通用围栏扫描：逐行遍历 Markdown 文本，收集满足 accept 判定的代码块内容（已 trim）。
 * 抽自 extractJsToolBlocks / extractSubagentResultBlocks（两者原为逐行同构的两份 40 行实现，
 * 仅 flush 判定不同），减少重复、避免围栏解析规则漂移。
 * @param text 完整回复文本（含 Markdown 围栏）
 * @param accept 判定闭包：(code, lang) => 是否收录该块（lang 已转小写）
 */
function scanFencedBlocks(text: any, accept: (code: string, lang: string) => boolean): string[] {
  const blocks: string[] = [];
  if (!text || typeof text !== 'string') return blocks;

  const lines = text.split(String.fromCharCode(10));
  let inBlock = false;
  let lang = '';
  let buf: string[] = [];

  const flush = () => {
    const code = buf.join(String.fromCharCode(10)).trim();
    const l = (lang || '').toLowerCase();
    if (code && accept(code, l)) blocks.push(code);
    inBlock = false;
    lang = '';
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed.startsWith(FENCE)) {
        lang = (trimmed.slice(3) || '').split(' ')[0];
        inBlock = true;
        buf = [];
      }
      continue;
    }
    if (trimmed.startsWith(FENCE)) {
      flush();
      continue;
    }
    buf.push(line.replace(String.fromCharCode(13), ''));
  }
  if (inBlock) flush();
  return blocks;
}

/**
 * 从原始文本（含 Markdown 围栏）中提取 JS 工具代码块
 * 规则：
 * - cuckoo 代码块：一律视为工具脚本
 * - js / javascript 代码块：仅当整条回复只包含代码块、且代码调用了工具函数时才视为工具脚本
 *   （避免把正常回答里的示例代码误当作工具脚本执行）
 */
function extractJsToolBlocks(text: any): string[] {
  const onlyFences = hasOnlyFences(text);
  return scanFencedBlocks(text, (code, l) => {
    if (l === 'cuckoo') return true;
    return (l === 'js' || l === 'javascript') && onlyFences && looksLikeToolScript(code);
  });
}

/**
 * 从原始文本（含 Markdown 围栏）中提取 subagent_result 代码块内容。
 * subagent_result 是子代理的最终交付物，与 cuckoo 工具脚本不同——不执行，直接作为结果提取。
 * 权威源：cuckoo-code-master051/src/preload/dom/js-detector.js L104-148。
 * @param text 完整回复文本（含 Markdown 围栏）
 * @returns 每个 subagent_result 块的内容（已 trim）；无则空数组
 */
function extractSubagentResultBlocks(text: any): string[] {
  return scanFencedBlocks(text, (_code, l) => l === 'subagent_result');
}

/**
 * 统计一段 JS 代码中的 await 调用次数（任意 "await 标识符(" 形式，通配非白名单）。
 * 用于"单块内调用数门禁"：防止单块塞入过多工具导致结果体量爆炸。
 *
 * 与同文件 JS_TOOL_CALL_RE 的关系：
 * - JS_TOOL_CALL_RE（白名单）判定"这段代码是不是工具脚本"，宁缺毋滥，避免误执行示例代码；
 * - 本函数的正则（通配）为门禁计数，保守从严：await sleep(...) / await Promise.all(...)
 *   等非工具 await 也计入配额（与 0.5.1 一致）。若需收紧，可改用白名单思路，
 *   但须同步评估门禁严格度变化。
 * @param code 待统计的代码文本
 * @returns await 调用次数（上限 100）
 */
function countAwaitCalls(code: any): number {
  const c = String(code || '');
  const re = /\bawait\s+[A-Za-z_$][\w$]*\s*\(/g;
  let n = 0;
  while (re.exec(c) !== null) {
    n++;
    if (n > 100) break; // 极端情况保护
  }
  return n;
}

export {
  BT,
  FENCE,
  JS_TOOL_CALL_RE,
  looksLikeIncompleteCodeError,
  looksLikeToolScript,
  hasOnlyFences,
  extractJsToolBlocks,
  extractSubagentResultBlocks,
  countAwaitCalls,
};
