# Cuckoo Code 架构与开发指南

> **面向读者**：接手本项目的 AI 助手 / 开发者。
> **性质**：描述**重构后的实际实现**（2026-09 完成），不是规划稿。
> **权威性**：以本目录文档 + 代码为准；历史规划稿在 `docs/archive/refactor-2026/`（已过时，仅供追溯）。

---

## 一、这是什么

Cuckoo Code 是一个**零 Token 成本**的 AI Agent 桌面应用：

- 用 Electron 把 AI 网页版（DeepSeek / Claude / ChatGPT）嵌入本地窗口
- 注入覆盖层 UI 与"网络拦截 hook"，捕获 AI 的完整回复
- 引导 AI 输出 `cuckoo` 代码块（JavaScript 工具调用）
- 在受限 vm 沙箱执行，结果回传 AI，形成 Agent 循环
- **不需要 API Key**，复用网页版账号

---

## 二、快速索引

| 文档 | 内容 | 何时看 |
|---|---|---|
| [01-结构.md](./arch/01-structure.md) | 目录结构与每个文件的职责 | 找"某个功能在哪个文件" |
| [02-依赖.md](./arch/02-dependency.md) | 依赖方向铁律 + ESLint 强制 | 新增 import 前必看 |
| [03-构建.md](./arch/03-build.md) | 构建流程、自动生成物清单 | 改构建 / 困惑于"生成文件" |
| [04-运行时.md](./arch/04-runtime.md) | 主进程 / 壳窗口 / AI 页面 / preload 数据流 | 理解整体如何跑起来 |
| [05-任务.md](./arch/05-tasks.md) | **常见任务手册**（加工具/加平台/改 UI） | **做新需求时最先看** |
| [06-测试.md](./arch/06-testing.md) | 测试与验证命令 | 提交前 |

---

## 三、技术栈

| 项 | 版本 / 说明 |
|---|---|
| 运行时 | Electron 44 |
| 语言 | TypeScript 7（主应用 `strict`） |
| 模块 | 纯 ESM（`"type": "module"`） |
| 构建 | `tsc` 编译到 `out/`；esbuild 打包 hook |
| 测试 | Vitest 5 |
| Lint | ESLint 10（含自定义依赖护栏规则） |
| 打包 | electron-builder |

---

## 四、30 秒鸟瞰

```
┌─────────────────────────────────────────────────────────┐
│ Electron BrowserWindow（每个 profile 一个）              │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ webContents = 地址栏壳页面（src/ui/shell.html）    │   │
│  │   preload: src/app/shell-preload.ts               │   │
│  │   ↑ shellAPI: navigate/back/forward/reload/home   │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ WebContentsView = AI 网页（deepseek.com 等）       │   │
│  │   preload: src/bridge/entry.ts                    │   │
│  │   ↑ 注入 hook（拦截 fetch/XHR 抓回复）             │   │
│  │   ↑ 注入覆盖层 UI（overlay/）                      │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
         │ IPC（contextBridge electronAPI）
         ▼
┌─────────────────────────────────────────────────────────┐
│ 主进程（src/app/entry.ts）                                │
│  ├── IPC 处理器（src/app/ipc/*）                          │
│  ├── 工具系统（src/tools/*）→ 沙箱执行 AI 生成的 JS        │
│  ├── 会话/项目（src/session/*）                            │
│  └── MCP 客户端（src/mcp/*）                               │
└─────────────────────────────────────────────────────────┘
```

**关键点**：AI 网页在一个 **WebContentsView** 里，窗口自身的 `webContents` 是地址栏壳页面。因此**任何"对当前 AI 页面操作"的代码，都要通过 `windowState.getContextByWebContents(...)` 拿到 `ctx.view`，而不是 `ctx.win.webContents`**。

---

## 四·五、任务提示词（docs/prompts/）

开新 AI 对话做任务时，把对应提示词发给它：

| 任务 | 提示词 |
|---|---|
| 做一个新需求（建分支+档案） | [new-requirement.md](./prompts/new-requirement.md) |
| 补全单元测试 | [write-unit-tests.md](./prompts/write-unit-tests.md) |

需求档案规则见 [docs/requirements/README.md](./requirements/README.md)，总览见 [INDEX.md](./requirements/INDEX.md)。

---

## 四·六、子代理副账号池（T2，2026-09-30）

主对话可用 `runAgent(name, task)` 把任务**委派**给独立上下文的子代理，只回摘要（见 [agents.md](./agents.md)）。

**账号模型**：
- **主账号** = **最近活跃窗口的 profile**（`profile.ts` `getLastActiveProfileId()`，由 `entry.ts` 在窗口获得焦点时写入；子代理窗口不写入）。无记录或记录失效（指向已删除 id）→ **回退首位** `profiles[0]`。
- **副账号池** = `profile-list.json` 中**除主账号外的全部账号**。子代理按**游标轮转**选号，用该副账号的**独立 partition**（独立登录态），与主窗口账号隔离，避免同账号并发触发 429。
- 池为空（除主账号外无其他账号）→ **报错**，不借主账号。

**机制落点**：

| 模块 | 文件 | 职责 |
|---|---|---|
| **M-profile** | `src/app/profile.ts` `createSubagentProfile(account, agentName)` | 用**池账号**的 `partition`/`providerId` 造临时 profile（`isSubagent: true`），**不写入** `profile-list.json`（窗口关闭即弃） |
| **M-subagent** | `src/app/subagent.ts` `getSubagentAccount()` | 显式判据选主账号 → 池 = 其余 → 游标轮转（游标取模归一，`_poolCursor` 模块级内存游标） |
| 窗口上下文 | `src/app/window.ts` `WindowContext.isSubagent` | `addWindow(..., isSubagent)` 透传判定，供 IPC 层区分（统一判定机制，不再用 id 前缀猜测） |

**partition 独立语义**：每个 profile 对应一个 Electron `partition`（`persist:<provider>:<profileId>`）。子代理窗口复用**池账号**的 partition，因此与主窗口 **partition 不同 → localStorage / 登录态不同** → 子代理 token 消耗**不计入**主窗口「窗口累计」（不同 partition = 不同 localStorage），用户 2026-09-30 裁定可接受。

### 子代理五层超时 + observer-ready 握手（T2b，2026-09-30）

子代理任务运行时状态机落于 `src/app/subagent.ts`（`activeTasks: Map<taskId, SubagentTaskState>`，替代旧单层 pending）。**五层超时**：

| 层 | 常量 | 值 | 触发动作 |
|---|---|---|---|
| 1 总超时 | `DEFAULT_TIMEOUT_MS` | 120min | 从 run 起算，覆盖 starting+working → `_failTask` |
| 2 starting 超时 | `STARTING_TIMEOUT_MS` | 60s | 握手未达 → `_failTask` |
| 3 空闲提醒 | `IDLE_TIMEOUT_MS`(`IDLE_TIMEOUT_BY_PROVIDER.glm`=12min) × `IDLE_REMINDER_MAX`=2 | 180s×2 | 发 `subagent-reminder`，超限静默 |
| 4 静默硬看门狗 | `SILENCE_TIMEOUT_MS` | 15min | 最后真实活动后无进展 → `_failTask`（止损） |
| 5 轮次硬顶 | `MAX_INTERACTION_ROUNDS` | 150 | 达顶 → phase=`force_deliver`，提示输出 `subagent_result` |

**信号驱动**（超时靠真实活动重置，系统自身提醒不重置）：
- 工具执行（`execute-tool`/`execute-js` IPC）→ `markActivity`（重置 idle + silence）
- AI 回复到达（bridge 上报 `subagent-round`）→ `recordRound`（轮次计数 + 重置 silence）
- 握手（bridge 上报 `subagent-ready`）→ `onSubagentReady` → resolve readyPromise（starting → working）

**IPC 通道**（`src/app/ipc/subagent.ts`、`src/app/ipc/tool.ts`）：`subagent-ready`、`subagent-round`（新增）；`execute-tool`/`execute-js` 接入 `findTaskByWebContents` + `markActivity` 门禁（force_deliver 后返回失败）。

**顺序约束**（对齐 051 L155-165 → L168）：`subagent-round` 上报位于 bridge `onInterceptedResponse` 回调顶部（`extractJsToolBlocks` 之前），天然早于 observer 的工具调用门禁——轮次硬顶先于门禁执行。被门禁拦截的轮次仍计入轮次硬顶（保持 051 保真，详见 `docs/plans/T2b-五层超时-实现报告.md` §五）。

**公开接口**（`src/app/subagent.ts` 新增导出）：`findTaskByWebContents(sender)`、`markActivity(state)`、`recordRound(state)`、`onSubagentReady(sender)`。

**已知取舍（T2b M-2）**：`force_deliver` 阶段 `recordRound` 仍先重置 silence 计时器再返回 false（051 L715/L718 逐行保真）→ **层4 静默看门狗在该阶段对「含工具块」轮次失效**。设计上由层1 总超时（120min）兜底，不会永久悬挂。此为 051 保真取舍，非缺陷；若后续调整需同步 `src/app/subagent.ts` 该处注释。

### 子代理完成判定 + 首条消息三段式（T2c，2026-09-30）

**完成判定改围栏**：子代理的「完成」从「无工具=完成」改为 **`subagent_result` 围栏=完成**（对齐 051 intercept-observer.js L215-257）。bridge 侧按优先级：① 工具块（`extractJsToolBlocks`）→ 计轮执行；② `subagent_result` 围栏（`extractSubagentResultBlocks`）→ 完成上报；③ 纯文本 → `plain_text` 候选。混合输出（工具块+围栏）以工具块优先（对齐 051）。

**首条消息三段式**：角色段（agent 模板全文 + 身份声明，prepend）→ base（主窗口工具提示词，`isSubagent=true` 时过滤 `runAgent` 工具 + 抑制 MCP 章节 + 不注入 CUCKOO.md）→ 协议段（子代理模式 + 回复模式 A/B/C + 交付方式 + 禁止 + 行为规则 + 任务）。

**IPC 通道**（`src/app/ipc/subagent.ts`）：`subagent-candidate-result`（bridge 上报候选结果，payload `{ type: 'subagent_result' | 'plain_text', text }`）。旧 `subagent-response` 通道已删除（无生产调用者）。

**公开接口**（`src/app/subagent.ts` 新增）：`handleCandidateResult(sender, payload)`；bridge 新增 `subagent-prompt.ts`（`buildRoleSection` / `buildProtocolSection`）、`js-detector.ts` 新增 `extractSubagentResultBlocks`。

**已知取舍（T2c n-1）**：`isSubagent` 仅抑制 MCP 章节 + CUCKOO.md + 过滤 runAgent；skills/agents/rules 章节仍注入（含「可用子代理」清单与已过滤的 runAgent 轻度不一致），归 T2f/T8 收口。

### 子代理质量防线（T2d，2026-09-30）

三块（对齐 051 subagent-runner.js L290-352 / L736-763 / L1085-1094）：

**① 敷衍检测 + 追问**：`handleCandidateResult` 收到 `subagent_result` 后先 `isTrivialResult(text)`（长度 < 30 / 敷衍话术开头且 < 100 / 单句且 < 100）→ 敷衍则 `_sendSupplement` 追问（发 `subagent-reminder` 到 `state.view.webContents`），**不 resolve**；`supplementCount` 上限 2，超限接受最后一次并附 warning。

**② 结果真实性校验**：`checkResultAuthenticity(state, text)` 从结果提取声称的文件路径（绝对/相对/盘符）→ 核对存在性 + mtime（早于 `state.startedAt` 视为旧文件冒充）→ 不一致附 warning，**不阻塞 resolve**。

**③ 停住检测**：`plain_text` 候选 → `handlePlainText(state, text)`；`hasToolActivity=true` 仅记录（策略B）；否则发"请继续执行任务"提醒，上限 `STALL_REMINDER_MAX=2` 超限静默。

**公开接口新增**（`src/app/subagent.ts`）：`isTrivialResult(text)` / `checkResultAuthenticity(state, text)` / `handlePlainText(state, text)`；`SubagentCandidateResult` 新增 `warning?`。

**State 新增**：`hasToolActivity`（markActivity 置 true）/ `stallReminderCount` / `supplementCount` / `startedAt`（创建时 Date.now()）/ `projectDir`。

**已知差异（T2d Nit-1）**：`markActivity` 置 `hasToolActivity=true` 置于 force_deliver 判断**之前**（051 L700 在其后）→ force_deliver 阶段纯文本走策略 B（静默）而非场景 A（提醒）。方向更合理（已达硬顶不再催），有意差异，已注释。

**warning 送达（Minor-2 修复）**：`_completeTask(state, text, warning?)` 将 warning 追加到交付文本尾部（`<text>\n\n[质量警示] <warning>`），随 `state.resolve` 返回，经 runAgent → runAgent 工具 ToolResult 到达主 AI 与用户。

> 变更源：`docs/plans/subagent-port-spec.md`（§八契约影响）；历史档案 `docs/requirements/016-subagents.md`（已 superseded）。

### 子代理登录检测 + worker partition 降级（T2e，2026-10-01）

把 0.5.1 的「子代理登录检测 + 未登录降级到 worker partition」移植到 0.8.6（权威源 `subagent-runner.js` L101-123 / L585-618 / L768-841 / L18）。

**机制**：
- **登录检测**（`_checkLogin(state)`）：注入 `LOGIN_CHECK_JS` 检测子代理窗口登录态（三特征：URL 跳登录页 / 无聊天输入框 / 有登录按钮）→ 返回 `{ loggedIn, reason }`。
- **检测 + 降级**（`_checkLoginAndFallback(state)`）：子代理窗口启动后（runAgent 的 `_createWindow` 之后、等 resultPromise 之前）检测登录态——已登录 → `_handleLoggedIn`（写 `pendingProjectDir`，握手归 readyPromise handler 完成）；未登录 → 降级到 worker partition（`WORKER_PARTITION = 'persist:subagent-worker'`）重建窗口；worker 仍未登录 → `_failTask`。
- **降级重建**（`_fallbackToWorker(state, check)`）：重置 readyPromise → 关旧窗 → 用 `state.subagentConfig` 复制完整配置 + `partition: WORKER_PARTITION` 调 `_createWindow` → 刷新 `state.win/view/windowId` → 二次检测。

**086 架构适配（关键差异 vs 051）**：
1. **登录检测注入 `view.webContents`（AI 页）**，而非 `win.webContents`（壳页面）——086 是双层窗口（壳 BrowserWindow + AI 页 WebContentsView）；051 是单层窗口（注 win 正确）。`_checkLogin` 从 `state.view` 取 AI 页 webContents。
2. **worker 降级传完整 profile**：086 `createWindow(profile)` 只接一个参数（无 051 的 `windowFactory(profile, opts)` 第二参）；故构造 profile 时携带 `partition: WORKER_PARTITION` / `providerId` / `isSubagent: true` / `subagentConfig`，`entry.ts` 内部 `addWindow(..., isSubagent)` + `subagentConfig` 序列化经 additionalArguments 传给 bridge。
3. **首条消息不在此发送**：086 由 `bridge/subagent.ts` 的 `initProject`（子窗口自身触发）发送首条消息；主进程侧只负责写 `pendingProjectDir`（`_handleLoggedIn`）。051 主进程侧发 `subagent-task`，086 无该通道。
4. **`_handleLoggedIn` 不重复推进 starting→working**：`readyPromise` 的 handler（`_attachReadyHandler`）已在握手时推进 phase（T2b 已建立），`_handleLoggedIn` 仅做后续动作。
5. **`_checkLogin` 恒返回对象、永不返回 null**（对齐 051 L846-854）：view / webContents 缺失或已销毁 → `{ loggedIn: false, reason: 'view-destroyed' }` 走降级；执行抛错 → `{ loggedIn: false, reason: 'execute-error:...' }` 走降级。
6. **登录检测经 `did-finish-load` 门控**（`_whenPageReady`，对齐 051 L557-560）：等 AI 页 `did-finish-load`（页面已加载完则直接进入）后再叠加 1500ms，避免页面未加载完时在空白页执行 `LOGIN_CHECK_JS` → 误判未登录而关掉已登录窗口（T2e Blocker-1）。首次检测 + 降级二次检测两处均门控。
7. **`_attachClosedHandler(win, state)` 为初始窗口与降级重建窗口共用**（对齐 051 L568-580）：用户手动关窗 → `_failTask('子窗口被手动关闭')`，避免 runAgent 挂到 120min 总超时（T2e Major-2）。内部 `state.win !== win` 守卫防降级串线。

**State 新增**：`currentPartition`（初始 = 池账号 partition；降级后 = WORKER_PARTITION）/ `subagentConfig`（worker 降级重建 profile 时复制）。

**runAgent 收尾关窗**改为按 `state.win`（降级后指向新窗口），而非常量 `windowId`，保证降级重建的窗口也能关闭。

**已知取舍（T2e）**：086 副账号池下池账号 partition 通常已登录（有 Cookies）；worker partition 是全新空 partition（无登录态）——降级实际多会失败（走 `_failTask`）。按用户要求「机制保真移植」，保持与 051 一致。待正式版接入可配置账号池（loom）时，worker partition 的登录态预置归该阶段。

> 变更源：`docs/plans/subagent-port-spec.md` §二 / §三（T2e）。

### 子代理 IPC 面（T2f，2026-10-01）

把 0.5.1 的子代理 IPC 面移植到 0.8.6（权威源 `subagent-runner.js` L1135-1192 / `ipc.js` L258-289）。

- **主进程导出**（`src/app/subagent.ts` 新增）：`abortByWindowId(windowId)`（按 windowId 中止 → `_failTask('子 Agent 任务已被用户中止')`）/ `focusByWindowId(windowId)`（`state.win` restore + focus，已销毁跳过）/ `getStatusList()`（仅 starting/working/force_deliver，返回 `{ taskId, agentType, provider, elapsedMs, windowId }`；086 用 `subagentConfig.agentName` 作 agentType 等价，provider 取 `state.provider`（未定平台为 null））/ `setStatusChangeHandler(fn)`（T10 二次修复：任务注册表增删时回调，供装配层广播状态）。
- **IPC handler**（`src/app/ipc/subagent.ts` 新增）：`subagent-abort` / `focus-subagent-window`（均校验 `typeof windowId === 'number'`，非法返回 `{success:false, error:'windowId 非法'}`）/ `get-agent-list`（用 `scanAgents(当前窗 projectDir)` 扫项目级 + 用户级；agentDir 回落 `~/.cuckoo/agents`）/ `get-subagent-status`（T10 拉取初始状态，返回 `{ success, tasks }`）。
- **状态推送（T10，`subagent-status` 通道）**：主进程 push 模型（对齐 051 `main/index.js` L347-383）。`entry.ts` 注册 `setStatusChangeHandler`：有任务 → 立即广播 `getStatusList()` 并经 1s ticker 持续推送；无任务 → 推空列表并停 ticker。`broadcastSubagentStatus` **排除子代理窗口**（`windowState.getAllContexts().isSubagent`），仅推送至壳窗口 `win.webContents`（`'subagent-status'`）。壳 preload 暴露 `onSubagentStatus(cb)` 订阅；`shell.html` 页面加载即订阅，进入 tab 时经 `get-subagent-status` 拉一次初始状态。**发送侧（preload / 控制台 UI）归 T10**。

### 子代理结果落盘 + 7 天清理（T2g，2026-10-01）

把 0.5.1 的结果落盘 + 清理移植到 0.8.6（权威源 `subagent-runner.js` L1068-1087 / L889-920 / L72）。

- **落盘**：`handleCandidateResult` 通过（敷衍/真实性校验后）时写 `{projectDir}/.cuckoo/subagent-results/{taskId}.md`（`fs.mkdirSync recursive + writeFileSync utf-8`）。落盘失败 → 返回 `{success:false, accepted:false, error:'落盘失败: ...'}` 且**不 resolve**（对齐 051；任务由五层超时兜底）。projectDir 为 null 时回落 `process.cwd()`（对齐 051）。
- **清理**：`runAgent` 委派时调 `_cleanupOldResults(projectDir)` → 对 `subagent-results` / `subagent-tools` 各执行一次 `_cleanupDir`（删 mtime > 7 天文件，`RESULTS_CLEANUP_MAX_AGE_MS`；目录不存在静默跳过）。
- **resultFile 送达**：086 `runAgent` 返回 string（非 051 对象），resultFile 以 `\n\n[完整报告] <path>` 追加到交付文本尾部送达主 AI（与 T2d warning 追加同法）。
- `.gitignore` 已忽略 `**/.cuckoo/subagent-results/` 与 `**/.cuckoo/subagent-tools/`（运行时产物）。

> 变更源：`docs/plans/subagent-port-spec.md` §二 / §三（T2f / T2g）。

---

## 五、三条必记规则

1. **依赖方向单向**（见 [02-依赖.md](./arch/02-dependency.md)）：`infra ← providers ← tools ← bridge ← session ← app`，overlay 不依赖 bridge/session。
2. **别手改生成文件**（见 [03-构建.md](./arch/03-build.md)）：`*.generated.ts`、`src/tools/api.d.ts` 由构建脚本产出。
3. **改工具只改一处**（见 [05-任务.md](./arch/05-tasks.md)）：工具的 API 契约、沙箱注入、提示词章节全自动同步。
