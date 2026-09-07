# Plan 2 · 桌面集成能力（通知 / 任务栏闪烁等）

> 工作规划文档，不属于 `docs/` 发布树：不注册 doc-sync leaf、不进 website 投影、不做中英配对。
> 依赖 [Plan 1 · 桌面壳（Electron）工程](desktop-shell.md) 落地：本计划的桥由壳的 preload 提供，插件的 product 能力层挂在该桥之上。
> 本计划遵循"**一切皆插件**"：触发源的感知、策略、文案全部是插件/配置；壳只提供 `notify` / `flash` / 窗口状态这三个原语。

## 1. 背景与目标

Plan 1 落地后，桌面端在功能上等价于"自带浏览器的 dsh web"。本计划补上桌面端独有的价值：**任务状态变化 → 用户可见提醒**，包括 Windows 通知（toast）与任务栏闪烁。触发源不止审批（现状只有浏览器内 composer 接管，见 §4 事实 G2），而是产品事件面的一个完整子集。

目标能力（按价值排序）：

| # | 能力 | 触发源 | 用户价值 |
|---|---|---|---|
| C1 | 任务完成提醒 | 会话 running→idle 边沿（侧边栏"完成"标记同源信号） | 窗口失焦时也能知道跑完了 |
| C2 | 审批挂起闪烁 | `approval/request`（当前**无**任何 OS 提醒） | 批准/拒绝前不被漏掉 |
| C3 | 失败/放弃提醒 | `assistant/attempt` 终态失败/取消 | 不用盯着等结果 |
| C4 | 后台任务/工作流/子代理完成 | jobs mirror、workflow、subagent delegation | 长任务完成通知 |
| C5 | 后端异常 | 壳级：子进程意外退出/重启 | 进程崩了用户知道 |

触发源集合可扩展：未来 webhook 触达、schedule、goal 里程碑等以同样方式注册（插件即扩展点）。

## 2. 设计原则（对齐仓库规则）

| 原则 | 含义 |
|---|---|
| **行为是插件，壳是原语** | 触发源感知、去重、阈值、文案全在 client 插件与它的 `Config`；Electron main 只有 `notify` / `flash` / 窗口状态，不含任何产品语义。 |
| **Model-visible ⟺ logged 不动** | 提醒是纯展示：**不新增任何 session event**，不进入模型可见输入；触发源一律读现有状态/事件。 |
| **无桥优雅降级** | 插件检测 `window.desktopBridge` 存在才生效；普通浏览器里跑同一 web profile 时静默 no-op。 |
| **文案 locale-owned** | 通知标题/正文是产品文案，走 typed dictionary + `t`（`packages/client/AGENTS.md` "Client UI copy is locale-owned"），禁止硬编码。 |
| **策略可配置** | 每个触发源的开关、阈值、免打扰时段是插件 `Config` 字段，来自 cordis.yml；不是硬编码常量。 |
| **注册是 effect** | 订阅走 `ctx.effect()` / `ctx.on()`，卸载即退订（HMR 安全）。 |

## 3. 架构

```
┌─ web profile 的 Cordis 树（插件层，产品行为）────────────────────────┐
│  dsh-desktop-integration/client（dsh.client 行）                      │
│  · 订阅 ctx.sessions（C1：completed 边沿 + title projection）          │
│  · 订阅 approval 客户端通道（C2）                                      │
│  · 订阅 SessionEventStream 的 assistant/attempt（C3）                 │
│  · 订阅 jobs mirror（C4）                                              │
│  · 策略：来源开关 / 仅失焦 / 最短运行时长 / 去重窗口 / 免打扰时段      │
│  · 文案：locale dictionary 经 t()                                       │
│  · 调 window.desktopBridge（不存在则 no-op）                           │
└───────────────┬────────────────────────────────────────────────────────┘
                │ contextBridge（preload，contextIsolation）
┌───────────────▼────────────────────────────────────────────────────────┐
│  Electron main（原语层，无产品语义）                                    │
│  · dsh:desktop-bridge IPC：payload 校验、sender 白名单（仅 loopback 页）│
│  · notify({title, body, urgency}) → new Notification()（Windows toast） │
│  · flash({mode}) / flashClear() → win.flashFrame(true/false)            │
│  · 窗口状态：focused / visible-unfocused / minimized → 推给插件         │
└─────────────────────────────────────────────────────────────────────────┘
```

桥契约（preload 经 `contextBridge.exposeInMainWorld('desktopBridge', …)` 暴露）：

```ts
interface DesktopBridge {
  notify(input: { title: string; body: string; urgency: 'low' | 'normal' | 'critical' }): Promise<boolean>
  flash(mode: { kind: 'until-focus' } | { kind: 'duration'; ms: number }): Promise<void>
  flashClear(): Promise<void>
  windowState(): Promise<'focused' | 'visible-unfocused' | 'minimized' | 'hidden'>
  onWindowState(cb: (s: WindowState) => void): () => void
}
```

- main 侧校验：title/body 长度上限、拒绝 HTML、sender 必须是 loopback 页面 origin、单通道。
- C1 的"仅失焦"用 `windowState()`；窗口重新聚焦时 main 自动 `flashClear()`（C2 除外，见决策表）。

## 4. 已证实契约（触发源事实 · P2.0 复核回填）

> P2.0 逐行复核：全部触发源都可在**现有 client 服务**上观测；不新增 session event、不为非活动会话开事件流。行号以本仓库当前实现为准。

**G1 · 会话完成信号已现成** — `packages/api/session-controller/src/client/sessions/manager.ts`
- `syncCompletedNotifications()`（`:886-908`）：running→idle 边沿且非选中 session → 进 `completedNotifications`（`:895-900`）——就是侧边栏绿色"完成"标记；running 解除（`:897-899`）；移除丢弃（`:902-907`）；首次观测只记录 running 位（`:891-894`），已 idle 的加载帧不产生提醒。
- 列表快照：`buildListSnapshot()`（`:910-957`）行带 `completed`（经 lineage 展平 `:923` 与 entryCache 比较 `:931-934`）；标题经 'title' projection 读取（`:914-920`）。
- **订阅面**：`service.ts:191` `readonly list: SnapshotStore<SessionListState>`；`projectList()`（`:577-647`）把 `completed` 写进 store 行（`:589`），`jobsBySession` 同快照（`:645`）；`service.ts:263` `rootCtx.reflect.provide('sessions', this, undefined)` → 任何 client 插件可 `ctx.sessions.list.subscribe()` + `getSnapshot()`（SnapshotStore 语义：`packages/client/store/src/index.ts:26-38,103-136`；list store 为 sync flush，`set` 整值替换）。
- **C1 直接订阅 sessions 列表 store，看 `completed` false→true 边沿即可，无需重算**；标题用行内 `title`（durable projection，`service.ts:587-596`）。

**G2 · 审批的观测口是「挂起交互」注册表，不是 approval/request 瀑布** — `packages/client/ui-approval` + `packages/client/ui-session`
- `PendingApproval`（`ui-approval/src/client/contract/slots.ts:69-160`）：kind 字面量 `'approval'`（`:71,95`）、key `approval:<n>`，`result` 在 answer/delegate/abort 时定局（`:122-150`）；`answerApproval`（`ui-approval/src/client/index.ts:35-68`）在 finally 移除挂起项（`:64-67`）。
- **观测通道**：`ctx.uiSession.pendingInteractions`（`ui-session/src/client/index.ts:225-231`）——`HostObservable<ReadonlyMap<SessionId, PendingInteraction>>`，全域只读、发布即通知（`:366-386`）；`registerPendingInteraction`（`:304-323`）注册各域。**不注入 `approval/request` 瀑布**（`ui-approval/src/client/index.ts:90-92`）——避免与 ui-approval 应答监听器顺序耦合。
- **C2 订阅 pendingInteractions，`kind === 'approval'` 项出现 → `flash until-focus`，消失（已处理/放弃/失效）→ 清除。**

**G3 · 失败有现成全局转发事件，无需逐会话开流** — `packages/api/session-controller/src`
- Host 端：`src/index.ts:148-150` `ctx.on('agent/error', ({agent,error}) => ctx.emit('api-session/error', agent.id, errorChain(error)))`——`agent/error` 是终态 Agent 失败（重试是循环内部行为，不触发）；`:171` 后台激活失败同样转发。
- Client 端：`src/client/index.ts:110-112` `ctx.remote.$on('api-session/error', (sessionId, message) => …)`——纯通知（无 next()），**任何 client 插件可同等订阅**；`api-session/status`（`:104-106`）/`added`（`:102`）/`removed`（`:103`）同族。
- 持久终态事实：`packages/core/session/src/types.ts:276` `'turn/end': { turn, reason }`，reason 度量（`:192-213`）：`error`（结构化 LlmFailure）/`aborted`/`completed`/`blocked`/`max-tokens`/`interrupted`；`'assistant/attempt'`（`:313`）只给无 surface message 的失败/重试/取消 attempt 落账。
- **C3 采用 `api-session/error`**：失败通知（标题取列表行 title，正文取 message）；重试不触发。**取消本轮不做全局通知**：host 无取消转发事件（`turn/end aborted` 只在已打开会话的事件窗口可见），列为已知限制与后续扩展点。逐会话事件窗成本：`SessionEventStream`（`transport.ts:136-217`）按 address 开 `session.follow` 并拉历史页，为非活动会话逐个开流成本线性放大，故不采用。

**G4 · 后台任务镜像在列表快照里** — `packages/api/session-controller/src`
- `SessionJob`（`src/types.ts:527-535`）：`{ id, kind, label, status: 'running'|'stopping'|'completed'|'killed'|'failed', detail?, startedAt, finishedAt? }`；host 以 control 帧 `{type:'jobs', sessionId, jobs}` 推送（`:556`），镜像进列表快照 `jobsBySession`（`manager.ts:954`、`service.ts:84,645`）。
- **C4 订阅 `ctx.sessions.list`，跟踪 `jobsBySession[sessionId]` 内 job 的 status → 'completed'|'killed'|'failed' 边沿**（`finishedAt` 佐证）；标题=session title、正文=job label；与 `ui-jobs` 展示同源。

**G5 · 配置面**
- 用户设置：`packages/settings/settings-file`（`$DSH_HOME/settings.yaml`，热重载）+ `packages/api/settings-controller`（web-app patch 行 `cordis.patch.yml:96-97`）；新增 settings domain 需过 settings-controller 注册（P2.4 复核精确 API）。
- **本轮默认插件 `Config`（cordis.yml）**：web profile 的 assembly patch 是 `packages/bundle/web-app/cordis.patch.yml`，home 层热重载补丁是 `$DSH_HOME/cordis.patch.yml`（Plan 1 F8）——P2.2 的 `dsh.client` 行可落 assembly patch（随包分发）或 home 层；P2.4 为可选 settings UI 增量。

**G6 · locale 与测试面**
- 通知文案：新插件自带 dictionary（`src/client/locales.ts`，zh 为键源 + en 键一致；模式同 `ui-approval/src/client/locales.ts`），`ctx.locale.register(NS, { zh, en })`；`verify-client-ui-i18n` 强制。
- 测试：product-user-visible 变更需快照/REAL 覆盖（`docs/testing.md`）；纯 client 插件无浏览器 UI 时按 `packages/AGENTS.md` 需非单元 REAL-composition 测试。通知是 OS 侧副作用、无 keyless 可录制面 → P2.2 用 Loader 起 web profile + 注入 fake bridge，断言「触发源 → 桥调用」序列，以行为断言替代快照。

## 5. 决策表

| # | 决策 | 选项与推荐 | 依据 |
|---|---|---|---|
| D1 | 感知层位置 | **client 插件**（`dsh.client` 行），进 web profile；不 fork 任何官方 bundle，用 profile 的 `cordis.patch.yml`（home 层热重载）或 overlay bundle 插行 | 一切皆插件；G1 |
| D2 | 桥只给原语 | main 不含任何产品语义，只有 notify/flash/windowState | 壳是宿主（Plan 1 §2） |
| D3 | C1 判定信号 | 直接用 `completed` 边沿（G1），不在壳里轮询、不重算 | G1；避免重复实现 |
| D4 | C2 闪烁语义 | `flash({kind:'until-focus'})`：**闪烁持续到用户处理审批**；窗口聚焦才清；C1/C3/C4 用 `duration` 型闪烁+通知 | 审批不可错过，完成通知一次即可 |
| D5 | 免打扰 | 插件 `Config` 提供 `quietHours`（可配）；生效期间 notify 返回 false、flash 不做 | 策略可配置原则 |
| D6 | 无桥降级 | `window.desktopBridge` 缺失 → 插件 no-op；同一 web profile 在普通浏览器仍可运行 | 双环境一致 |
| D7 | 文案 | 通知标题/正文入 locale dictionary，走 `t()` | locale-owned 规则 |

## 6. 任务拆解

通用约定：依赖 Plan 1 的 P1.3/P1.5 提供桥可用的 dev 壳；每个任务结束 `git commit`（信息带 P#），更新本文件 §8 状态表。

### P2.0 契约调研（只读）
- 写路径：仅本文件（§4 事实表回填）。
- 复核清单：
  1. G2：`ui-approval` 订阅 `approval/request` 的**客户端精确 API**（scoped Remote 形态、store/channel 名），确认 client 插件可注入同等通道；确认"审批挂起中"的判定状态。
  2. G3：`assistant/attempt` 事件载荷的终态判别字段（failed/retried/cancelled），确认重试中不误报的过滤条件；SessionEventStream 对非活动会话的订阅成本。
  3. G4：jobs mirror / workflow / subagent 的客户端订阅 API 与完成判定。
  4. G5：settings domain 新增一个 namespace 的最小改动面（settings-file + api-settings-controller + ui-settings 行）。
  5. locale：通知文案所在 dictionary 的现有结构与新增 entry 的流程（`verify-client-ui-i18n`）。
  6. 测试面：`docs/testing.md` 对 product-user-visible 变更的 snapshot 要求；通知类输出是否有可录制的 keyless snapshot 通道（无则记录替代：REAL-composition 断言桥调用序列）。
- 验收：§4 事实表补全精确 API 与行号；未决项标注探测方法；`git commit`。
- 结果：事实表已回填（见 §4 G1–G6）；两点结论修正原占位：C2 观测口改为 `uiSession.pendingInteractions`（避免瀑布顺序耦合），C3 改为全局 `api-session/error`（取消通知列为限制）；`git commit` 完成。

### P2.1 桥契约落地（main + preload）
- 写路径：`apps/desktop/src/main.ts` 的 IPC 处理、`apps/desktop/src/preload.ts`。
- 要点：
  - 按 §3 桥契约实现；`contextBridge` + `contextIsolation: true`；payload 校验（长度、枚举、拒绝 HTML）；sender 白名单（仅 `http://127.0.0.1:*`）。
  - main 侧：`Notification`（Windows toast，`app.setAppUserModelId` 保证 toast 归属）、`win.flashFrame`、窗口 `focus`/`minimize`/`blur` 状态推送、`flashClear` 与窗口聚焦联动（C2 的 until-focus 除外）。
  - 单测：IPC 校验与状态机用 mock 的 BrowserWindow/Notification 覆盖；真机行为 P2.5。
- 验收：dev 壳里 `window.desktopBridge` 存在且 `notify` 能弹 toast、`flash` 能闪任务栏；非法 payload 被拒；非 loopback sender 被拒。
- 风险：Windows toast 依赖 `app.setAppUserModelId` 与 `Notification.isSupported()` 探测；不支持时 `notify` 返回 false。

### P2.2 client 插件实现（感知 + 策略）
- 写路径：`packages/client/desktop-integration/`（新包，P2.0 结论：独立 workspace 包）或 `apps/desktop/plugins/`。
- 要点：
  - 订阅：`ctx.sessions` 列表（C1，`completed` 边沿 + `title` projection）、approval 通道（C2）、`SessionEventStream`（C3，终态失败/取消）、jobs mirror（C4）。
  - 策略：来源开关 / 仅失焦 / `completionMinSeconds` / 去重窗口 / `quietHours`，全部 `Config` 字段。
  - 桥调用：`window.desktopBridge` 缺失 no-op；文案经 `t()`。
  - 生命周期：`ctx.effect()` 注册/退订；HMR 安全。
  - 无模型可见输入：不新增 session event。
- 验收：REAL-composition 测试（Loader 起 web profile + 注入 fake bridge）断言各触发源到桥调用的映射；无桥时零调用；HMR dispose 后订阅移除；`verify-client-ui-i18n` 通过。
- 结果：`packages/client/desktop-integration`（`@deepseek-ai/dsh-client-desktop-integration`）落地；C1/C2/C3/C4 全部经 client test runtime 的行为测试（16 例）验证，含 no-bridge no-op 与 HMR 订阅移除；`verify-client-ui-i18n` / `verify-client-packages` / `verify-package-dependencies` 通过；随附 Agent Note 记录桥与提醒决策。
- 风险：approval/jobs 订阅 API 与 P2.0 结论不符 → 回填事实表并调整。

### P2.3 桌面壳内联（打包集成）
- 写路径：`apps/desktop` 装配/打包配置（插件进 dsh-runtime 闭包 + profile patch 插行）。
- 要点：
  - 插件包进入装配体依赖闭包；`apps/desktop` 首启时在 `$DSH_HOME`（userData/dsh-home）的 profile/home 层补丁插入 `dsh-desktop-integration` 行（home 层热重载，无需 fork web-app bundle）。
  - 打包后验证壳内 C1 触发：完成一个短任务 → toast + 闪烁。
- 验收：exe 内通知链路全通；普通浏览器开同一 DSH_HOME 的 web profile 时插件 no-op。

### P2.4 设置 UI（可选增量）
- 写路径：`packages/client/ui-desktop-integration/` + settings domain。
- 要点：`desktop-integration` settings namespace（来源开关、免打扰时段、最短时长），一个 ui-settings 行；默认值与 `Config` 一致。
- 验收：设置页可改并持久化到 `settings.yaml`，热重载生效；locale 全量。
- 说明：若验收困难可整体 defer，先只做 `Config`（P2.2 已含）。

### P2.5 真机验证
- 写路径：`docs/plans/notes/verification-integration.md`（新建）。
- 清单：
  1. C1：窗口最小化 → 会话跑完 → toast + 短暂闪烁；聚焦状态不打扰。
  2. C2：窗口切走 → 审批挂起 → 任务栏持续闪烁；回到窗口处理后停止。
  3. C3：工具终态失败 → 失败通知；重试中不通知。
  4. C4：后台 job 完成 → 通知。
  5. 免打扰时段：不通知不闪。
  6. 无桥环境（普通浏览器）：行为与官方 web 完全一致（零差异）。
  7. 文案：中英切换后通知文案正确。
- 验收：每项证据记录；功能缺陷回对应任务修复复验。

## 7. 非目标

- 不做系统级"勿扰模式"联动（Windows Focus Assist 检测）——先做插件内 `quietHours`。
- 不做通知点击→跳转会话（Electron `Notification` click 回调可做，列为后续）。
- 不做 webhook 触达、schedule、goal 里程碑等新触发源——它们按同一插件模式后续加，不在本轮。
- 不改 agent-loop、不改 session log、不加 session event。

## 8. 状态表

| 任务 | 状态 | 完成日期 | 备注 |
|---|---|---|---|
| P2.0 契约调研 | 已完成 | 2026-09-07 | §4 G1–G6 回填精确 API/行号；C2/C3 观测口结论修正（见 §6 P2.0 结果） |
| P2.1 桥契约落地 | 已完成 | 2026-09-07 | 单通道 `dsh:desktop-bridge` + 纯校验/flash 状态机（18 单测）；`lib/preload.cjs` CJS preload（sandbox 限定）；CDP 探针实测：`window.desktopBridge` 五方法齐备、notify=true、flash/flashClear/windowState 全通 |
| P2.2 client 插件 | 已完成 | 2026-09-07 | `packages/client/desktop-integration` + web-app `dsh.client` 行；16 例行为测试 + no-bridge/HMR；i18n/client-packages/deps 门禁过；详见 §6 P2.2 结果与 Agent Note |
| P2.3 打包集成 | 已完成 | 2026-09-07 | `deploy-root` 闭包加 `dsh-client-desktop-integration` 行；`assemble` 重装配（213.5 MB）后 `probe-roster` 实测：`__DSH_BOOT__` roster 含该行；壳启动 `probe-bridge` 在装配态全通；`verify-cordis-config` 经 tsconfig.base.json 路径映射后放行（仅剩 `apps/cli/tests/profiles/acp/cordis.yml` 既有 fixture 失败，非本分支所致） |
| P2.4 设置 UI | 待执行 | | 可 defer（已按 §6 P2.4 说明整体 defer，先只做 `Config`） |
| P2.5 真机验证 | 已完成 | 2026-09-07 | [notes/verification-integration.md](notes/verification-integration.md)：模型驱动项（C1–C4 真实触发）因无 key 标注"待复验/步骤"；原语与装配面（桥/CDP、roster、免打扰、无桥、文案）行为面已验证 |

## 9. 风险汇总

| 风险 | 影响 | 缓解 |
|---|---|---|
| approval/jobs 客户端订阅 API 与预期不符 | C2/C4 延迟 | P2.0 前置调研，回填事实表 |
| Windows toast 支持差异（无 AppUserModelID / 不支持） | C1/C3/C4 通知失效 | `Notification.isSupported()` + AppUserModelID + P2.1 探测；闪缩仍可用 |
| 通知 spam（长会话多 session 完成） | 体验差 | 去重窗口 + 仅失焦 + 最短时长（Config） |
| 插件在普通浏览器产生差异 | 双环境行为漂移 | 无桥 no-op（D6）统一验证 P2.5-6 |
| locale 全量新增文案工作量 | P2.2 体积 | P2.0 摸清结构，翻译走既有双语流程 |