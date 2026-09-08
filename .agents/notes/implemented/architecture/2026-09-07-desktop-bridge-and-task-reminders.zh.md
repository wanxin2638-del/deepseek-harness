# Agent Note：桌面壳桥与任务状态提醒（通知 / 任务栏闪烁）

Status: implemented

[English](2026-09-07-desktop-bridge-and-task-reminders.md) | 中文

## 问题

Windows 桌面壳（[apps/desktop](../../../../apps/desktop/README.zh.md)，Plan 1）承载 web profile；本次改动之前，它没有任何 OS 级注意力原语。任务状态变化只在窗口聚焦时到达用户：完成的会话点亮侧边栏绿色"完成"标记，挂起的审批只能在 composer 接管内应答。窗口失焦时完成被无声略过、审批无人应答。新能力是"任务状态变化 → 用户可见提醒"，壳只提供三个原语 —— toast、任务栏闪烁、窗口状态 —— 不含任何产品语义。

## 决策

**壳经单条 IPC 通道暴露三个原语；触发源、策略与文案全部在 web profile 的 client 插件里。**

1. **桥契约**（`apps/desktop/src/bridge/contract.ts` + `preload.cjs`）：单通道 `dsh:desktop-bridge` 承载 `notify({title, body, urgency})`、`flash(until-focus | duration)`、`flashClear()` 与 `windowState()`；main 侧校验 sender 来源（仅 loopback 页面）、载荷形状与长度上限，并拒绝标签样文本。渲染端全局是 `window.desktopBridge`，由 CommonJS preload 暴露（沙箱 preload 只能用 CommonJS —— `src/preload.cjs` 在构建时复制为 `lib/preload.cjs`）。
2. **闪烁语义**（`FlashController`）：窗口聚焦清除一切闪烁；`until-focus` 无定时器，`duration` 到时自清。新闪烁取代旧闪烁。窗口的 `closed` 事件移除 IPC 处理器、聚焦监听器和待触发的定时器；壳适配器在调用 `flashFrame` 前检查 `isDestroyed()`。清理绑定在 `closed` 上，因为 `close` 可以被取消。
3. **插件**（`@deepseek-ai/dsh-client-desktop-integration`，web profile 的 `dsh.client` 行）：观测者骑在现有 client 通道上 —— 会话列表 store 取 `completed` 边沿（C1）与 `jobsBySession` 镜像（C4）、挂起交互注册表取审批（C2）、全局 `api-session/error` 转发取失败（C3）。每个动作先过插件 `Config` 策略（来源开关、`unfocusedOnly`、`completionMinDurationMs`、`dedupeWindowMs`、`quietHours`、闪烁时长）；没有 `window.desktopBridge` 时插件在创建任何订阅前短路（普通浏览器不受影响）。
4. **C2 观测挂起交互注册表，不碰 `approval/request` 瀑布** —— `uiSession.pendingInteractions` 是只读全局可观测源，插件与 ui-approval 应答者无需排序关系。
5. **C3 用全局 `api-session/error` 转发，不用逐会话事件流** —— host 在终态 `agent/error` 时发出；为非活动会话逐个开 `SessionEventStream`（每个都要拉历史页）成本线性放大，不可取。
6. **Windows toast** 依赖 `create Notification` 前调用 `app.setAppUserModelId`；`Notification.isSupported()` 为假时 `notify` 返回 `false`。

### 记录在案的非目标

取消的回合本轮没有全局提醒：host 只转发失败、没有单独的取消事件，`turn/end` 的 `aborted` 原因只在已打开会话的事件窗口可见。通知点击跳转会话语列为后续。不新增 session event、不改变任何模型可见输入。

## 备选方案

- **插件订阅 `approval/request` Remote 瀑布** —— 否决：相对 ui-approval 应答者的监听顺序决定谁应答；挂起交互注册表已经发布了"等人处理"这一事实。
- **C3 走逐会话 `SessionEventStream`** —— 否决：每个流各开一条 `session.follow` 连接并拉历史页，非活动会话逐个开流成本线性放大。
- **ESM preload** —— 否决：Electron 只把沙箱 preload 当 CommonJS 加载。
- **产品逻辑进壳** —— 否决于 Plan 1/Plan 2 分工：壳只留原语，行为归插件。

## 后果

- 桥契约在包边界处有意重复：`packages/` 不能依赖 `apps/desktop`，所以 `src/client/bridge.ts` 结构上镜像 `apps/desktop/src/bridge/contract.ts`；两者必须同步变化。
- 同一 web profile 现在在所有环境都带提醒插件；普通浏览器里它按构造 no-op（D6）。
- 长的失败消息在桥上限之前截断；壳负责校验、插件负责截断。
- 免打扰时段抑制 toast 与闪烁，包括审批闪烁。
- 壳在窗口聚焦时自动清除任何闪烁，聚焦的窗口不会一直闪；`until-focus` 是审批路径，插件在挂起项消失时也会显式清除。

## 测试

- 桥单元测试（`apps/desktop/tests/`）：请求校验矩阵、来源白名单、闪烁状态机（假定时器）、对 mock 的 `ipcMain` 做分发与销毁断言；CDP 探针脚本（`apps/desktop/scripts/probe-bridge.mjs`）在真实壳里验证渲染端（桥存在、`notify` → `true`、`flash`/`flashClear`/`windowState`）。
- 插件测试（`packages/client/desktop-integration/tests/`）：在 client 测试运行时（真实 Cordis ctx、真实 ui-session、TestSessions 替身）上断言触发源→桥映射 —— 完成边沿、首次观测基线、仅失焦门控、`completionMinDurationMs`、审批闪烁与释放、失败通知与去重与免打扰、任务转移、无桥 no-op、HMR 销毁移除全部订阅、zh/en 文案键一致。
- 门禁：`verify-client-ui-i18n`、`verify-client-packages`、`verify-package-dependencies`、client 聚合 typecheck、翻译配对。
