# Agent Note: Web 模型上下文查看器

Status: implemented

[English](2026-09-08-web-context-inspector.md) | 中文

## 问题

Session JSONL 导出把生命周期事件、请求头和产生消息的事件放在一起。浏览器直接拼接这些记录无法可靠识别模型历史：inbox splice 记录可能与 user message 重复，工具调用属于执行记录，浏览器已加载的窗口也可能缺少更早事件。用户需要查看完整的当前模型上下文，同时不修改 Session 数据，也不激活冷 Agent。

## 决策

`SessionController` 暴露只读的 `session.context` Remote 方法，可寻址普通 Session 或 direct subagent。Host 读取一个精确的 live 或持久化 observation，恢复 canonical Session 表示，并返回日志游标、最新记录的 `request/header` 和 `Session.deriveMessages()` 结果。Client `SessionFace` 以 `readContext(signal?)` 暴露同一能力。

Chat target 在 Chat 与 Trajectory 旁注册 `上下文` 标签。该标签使用共享 JSON tree 渲染 Host 结果，提供节点复制操作，在 event window 版本变化后重新读取，并丢弃较早读取的过期响应。target-neutral 的 Conversation 包不注册该标签，因此不带 Chat 的装配仍保持原有 View 列表。

返回结果将 request header 与 `messages` 分开。header 携带 provider 配置、system prompt 和工具 schema；`messages` 保留 provider-neutral content block、工具调用、工具结果、source 与消息身份。`asOfSeq` 标识两者共同对应的持久化日志位置。

## 曾考虑的替代方案

**在浏览器解析完整 JSONL 导出。** 不采用：这会把 Session surface fold 与请求重建逻辑复制到 Client bundle，并且必须先加载完整日志才能保证视图正确。

**新增原始 Session event 标签。** 不采用：原始生命周期记录不是模型上下文，会让所需的 `messages` 视图依赖用户理解内部事件类型。

**在 `ui-conversation` 注册标签。** 不采用：该包是 target-neutral，现有 wiring 契约允许不带 Chat 的装配没有 conversation View。面向产品的上下文 View 由 Chat target 拥有。

## 后果

Host 继续作为上下文重建的唯一所有者，因此 compaction、surface replacement、fork 前缀、工具结果和冷 Session 读取都使用与模型请求相同的规则。该读取是一个时间点快照；浏览器渲染前 Session 可能已经产生新 revision。revision 触发的刷新与 generation guard 让结果最终收敛，并避免旧响应覆盖新响应。该 View 会向已通过 Session 地址授权的读取方暴露 system prompt 与工具 schema，因此沿用现有 Session 授权，不新增共享或修改操作。

Host 与 Client contract 测试覆盖 request header、派生 user message、Remote 路由和 Client read 方法。Chat View 测试覆盖首次渲染、revision 刷新与本地化失败。Web 装配和完整浏览器验收仍由仓库更广泛的 Web 检查负责。
