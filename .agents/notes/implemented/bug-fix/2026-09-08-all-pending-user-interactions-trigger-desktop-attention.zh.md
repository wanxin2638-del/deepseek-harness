# Agent Note：所有挂起用户交互触发桌面提醒

Status: implemented

[English](2026-09-08-all-pending-user-interactions-trigger-desktop-attention.md) | 中文

## 问题

Web Client 通过共享的 `uiSession.pendingInteractions` 注册表暴露审批、提问与计划评审。桌面提醒如果只识别审批项，就会让提问和计划评审卡片没有任务栏提醒。交互也可能在壳窗口聚焦时出现；如果插件只在交互出现时检查 `unfocusedOnly`，用户之后切换到其他窗口就不会开始闪烁。

## 决策

`@deepseek-ai/dsh-client-desktop-integration` 将 `uiSession.pendingInteractions` 中的每一项都视为需要用户注意。C2 开关命名为 `flashOnInteraction`；至少有一项交互挂起且窗口符合提醒条件时，插件请求 `flash({ kind: 'until-focus' })`。插件在初始窗口状态读取完成后，以及每次窗口状态变化时重新检查挂起集合，因此交互挂起后窗口失焦也会开始闪烁。最后一项挂起交互移除时调用 `flashClear()`。

壳只负责闪烁原语，并在窗口获得焦点时清除闪烁。审批、提问与计划评审的生产方继续拥有各自的挂起载体和结算路径。

## 备选方案

- **保留只匹配审批的筛选** —— 否决：它覆盖不了 `uiSession.pendingInteractions` 已发布的其他用户交互载体。
- **只在挂起集合变化时闪烁** —— 否决：挂起项保持不变时，窗口仍可能从聚焦变为失焦。
- **删除 `unfocusedOnly` 条件** —— 否决：用户已经查看交互时也会请求任务栏提醒，改变现有提醒策略。

## 后果

- 提问与计划评审请求获得与审批相同的持续任务栏提醒。
- 现有 `unfocusedOnly` 行为仍可配置；交互在聚焦时出现时，壳之后报告失焦即可补上闪烁。
- 使用旧 `flashOnApproval` 配置键的部署必须改用 `flashOnInteraction`；client 配置尚未稳定。

## 测试

desktop-integration 行为测试覆盖审批、提问与计划评审挂起项、移除时清除，以及交互在聚焦时出现并在焦点变化后开始闪烁的场景。测试继续覆盖无桥与销毁路径。
