---
description: "桌面壳桥上的桌面专属任务状态提醒：完成、审批闪烁、失败与后台任务通知；面向 Windows 桌面壳体验的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-desktop-integration

[English](README.md) | 中文

## 概述

本包在 Web GUI 运行于 [Windows 桌面壳](../../../apps/desktop/README.zh.md) 内时，把任务状态变化变成桌面提醒：会话完成或后台任务落定时弹 toast 并短闪任务栏、任意用户交互挂起时任务栏持续闪烁、回合失败时弹严重级别 toast。它只读现有 client 状态与事件（`ctx.sessions.list`、`ctx.uiSession.pendingInteractions`、全局 `api-session/error` 转发），不发任何 RPC、不加 session event、永不进入模型请求。没有 `window.desktopBridge`（普通浏览器）时所有动作静默 no-op，因此该插件常驻 web profile 是构建期常量。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件作为 web profile 的 `dsh.client` 行挂在桌面壳旁边。壳的 preload 暴露 `window.desktopBridge`（notify / flash / 窗口状态），插件把每个触发源路由到桥上。需要窗口焦点状态时，插件读取壳推送的状态；策略全部来自 cordis.yml 的 `Config` 行：来源开关（`notifyOnCompleted`、`flashOnInteraction`、`notifyOnFailure`、`notifyOnJob`）、`unfocusedOnly`、`completionMinDurationMs`、`dedupeWindowMs`、`quietHours` 与两个闪烁时长。

### 提醒语义

会话完成边沿（侧边栏绿色"完成"标记）发普通 toast 并短闪。审批、提问或计划评审挂起时任务栏持续闪烁，直到窗口重新聚焦或交互结束；壳在聚焦时清除闪烁。如果交互在窗口聚焦时出现，用户随后切换到其他窗口时，插件会在焦点状态变化时开始闪烁。回合失败（host `agent/error` 转发）发严重级别 toast。后台任务进入 `completed`、`failed` 或 `killed` 时发对应 toast。所有 toast 与闪烁在 `quietHours` 内跳过、按类别与会话在 `dedupeWindowMs` 内去重，并受 `unfocusedOnly` 约束（默认只在窗口未聚焦时提醒）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件持有单个 effect，订阅四个现有来源：会话列表 store（完成边沿与 `jobsBySession` 镜像）、挂起交互注册表、Remote `api-session/error` 事件。完成提醒镜像 host 的首次观测规则（挂载时已完成的行不产生提醒），`completionMinDurationMs` 过滤使用客户端观测到的运行窗口。每次桥调用都先过本地策略闸门；桥全局缺失时整个插件在创建任何订阅前短路。文案位于本包的 `desktop-integration` locale 命名空间。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [桌面壳](../../../apps/desktop/README.zh.md) — 暴露桥原语的 Electron 壳。
- [Session Controller](../../api/session-controller/README.zh.md) — 本插件读取的列表 store、`jobsBySession` 镜像与 `api-session/error` 转发。
- [桌面集成计划](../../../docs/plans/desktop-integration.zh.md) — 整个通知能力的工作规划（不属于 docs 发布树）。

-----

<a id="model-experience"></a>
## 模型体验

无：本包消费现有 client 状态与事件、为人类渲染桌面通知；永不进入提示词、消息、schema、流或工具结果。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>


以下限制界定了当前提醒集合。它们是当前包约束，不是通用通知对比或任务积压。

- **取消的回合没有全局 client 信号** — host 只转发失败（`api-session/error`），没有单独的取消事件，因此用户主动停止不会产生提醒；取消回合只在已打开会话的事件窗口内可观测。
- **Windows toast 依赖壳** — `notify` 依赖 Electron `Notification` 支持与壳设置的 AppUserModelID；无法渲染 toast 时桥返回 `false`，只剩任务栏闪烁可用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

桥契约在包边界处有意重复：`apps/desktop` 是应用，`packages/` 下的任何东西都不能依赖它，所以 `src/client/bridge.ts` 在结构上镜像 `apps/desktop/src/bridge/contract.ts`。线契约变化时两者必须同步修改。

</details>

**运行时不变量：** 不发布配套。本包是会话列表、挂起交互注册表与 `api-session/error` 转发的纯消费方；它不拥有任何其它组件可观测的状态，因此没有可分歧的观测需要校验。其订阅拆除由 HMR 安全 spec 证明。
