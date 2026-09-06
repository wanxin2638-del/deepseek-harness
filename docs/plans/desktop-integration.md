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

## 4. 已证实契约（触发源事实）

**G1 · 会话完成信号已现成** — `packages/api/session-controller/src/client/sessions/manager.ts:886`
- `syncCompletedNotifications()`：running→idle 边沿且非选中 session → 进 `completedNotifications`（`:895-900`）——就是侧边栏绿色"完成"标记。
- 列表快照行带 `completed` 字段（`sessions/service.ts:588-589`，`lineage.ts:31`）；标题经 `title` projection 读取（`manager.ts:915`）。
- `ctx.sessions` 经 `reflect.provide('sessions', …)` 暴露给所有 client 插件（`service.ts:263`）。
- **C1 直接订阅 sessions 列表 store，看 `completed` false→true 边沿即可，无需重算。**

**G2 · 审批目前只有浏览器内提醒** — `packages/client/ui-approval`（bundle patch `cordis.patch.yml:215-216`）
- 审批请求经 `approval/request` 走 scoped Remote，`ui-approval` 订阅后**接管 composer** 渲染 `ApprovalPanel`（allow-once / reject）。
- **没有 OS 级通知/闪烁**：窗口未聚焦时审批会被漏掉 → C2 是本计划最高价值增量。
- 客户端订阅该 Remote 的精确 API 未逐行核实 → P2.0 任务复核。

**G3 · 失败/重试/取消是可观测终态** — `docs/architecture.md` turn flow
- `assistant/attempt` 是 durable session event（settled failed / retried / cancelled / stream-error）。
- 客户端经 `SessionEventStream`（`packages/api/session-controller/src/client/transport.ts:136`）订阅当前 session 的事件流。
- C3 只对**终态失败/取消**提醒（重试中不打扰）；精确过滤规则 P2.0 定。

**G4 · 后台任务/工作流/子代理**
- `tool-jobs`（`packages/jobs/tool-jobs`）+ `ui-jobs` 的 `jobsBySession` mirror；workflow、subagent delegation 相关。客户端精确 mirror/订阅 API 未逐行核实 → P2.0 任务复核。

**G5 · 配置面**
- 用户设置走 `dsh-settings-file`（`$DSH_HOME/settings.yaml`，热重载）+ `dsh-api-settings-controller`；P2.4 可新增 `desktop-integration` settings domain 做 UI 开关。
- 免打扰/开关也可先只做 `Config`（cordis.yml），settings UI 为可选增量。

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

### P2.1 桥契约落地（main + preload）
- 写路径：`apps/desktop/src/main.ts` 的 IPC 处理、`apps/desktop/src/preload.ts`。
- 要点：
  - 按 §3 桥契约实现；`contextBridge` + `contextIsolation: true`；payload 校验（长度、枚举、拒绝 HTML）；sender 白名单（仅 `http://127.0.0.1:*`）。
  - main 侧：`Notification`（Windows toast，`app.setAppUserModelId` 保证 toast 归属）、`win.flashFrame`、窗口 `focus`/`minimize`/`blur` 状态推送、`flashClear` 与窗口聚焦联动（C2 的 until-focus 除外）。
  - 单测：IPC 校验与状态机用 mock 的 BrowserWindow/Notification 覆盖；真机行为 P2.5。
- 验收：dev 壳里 `window.desktopBridge` 存在且 `notify` 能弹 toast、`flash` 能闪任务栏；非法 payload 被拒；非 loopback sender 被拒。
- 风险：Windows toast 依赖 `app.setAppUserModelId` 与 `Notification.isSupported()` 探测；不支持时 `notify` 返回 false。

### P2.2 client 插件实现（感知 + 策略）
- 写路径：`packages/client/desktop-integration/`（新包）或 `apps/desktop/plugins/`（按 P2.0 结论定包归属；推荐独立 workspace 包 + `dsh.client` 行）。
- 要点：
  - 订阅：`ctx.sessions` 列表（C1，`completed` 边沿 + `title` projection）、approval 通道（C2）、`SessionEventStream`（C3，终态失败/取消）、jobs mirror（C4）。
  - 策略：来源开关 / 仅失焦 / `completionMinSeconds` / 去重窗口 / `quietHours`，全部 `Config` 字段。
  - 桥调用：`window.desktopBridge` 缺失 no-op；文案经 `t()`。
  - 生命周期：`ctx.effect()` 注册/退订；HMR 安全。
  - 无模型可见输入：不新增 session event。
- 验收：REAL-composition 测试（Loader 起 web profile + 注入 fake bridge）断言各触发源到桥调用的映射；无桥时零调用；HMR dispose 后订阅移除；`verify-client-ui-i18n` 通过。
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
| P2.0 契约调研 | 待执行 | | |
| P2.1 桥契约落地 | 待执行 | | |
| P2.2 client 插件 | 待执行 | | |
| P2.3 打包集成 | 待执行 | | |
| P2.4 设置 UI | 待执行 | | 可 defer |
| P2.5 真机验证 | 待执行 | | |

## 9. 风险汇总

| 风险 | 影响 | 缓解 |
|---|---|---|
| approval/jobs 客户端订阅 API 与预期不符 | C2/C4 延迟 | P2.0 前置调研，回填事实表 |
| Windows toast 支持差异（无 AppUserModelID / 不支持） | C1/C3/C4 通知失效 | `Notification.isSupported()` + AppUserModelID + P2.1 探测；闪缩仍可用 |
| 通知 spam（长会话多 session 完成） | 体验差 | 去重窗口 + 仅失焦 + 最短时长（Config） |
| 插件在普通浏览器产生差异 | 双环境行为漂移 | 无桥 no-op（D6）统一验证 P2.5-6 |
| locale 全量新增文案工作量 | P2.2 体积 | P2.0 摸清结构，翻译走既有双语流程 |