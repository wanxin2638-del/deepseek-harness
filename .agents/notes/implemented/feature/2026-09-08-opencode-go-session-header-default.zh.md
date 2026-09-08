# Agent Note: OpenCode Go 默认使用会话标头

Status: implemented

[English](2026-09-08-opencode-go-session-header-default.md) | 中文

## 问题

OpenCode Go 要求每个模型请求使用 `x-opencode-session` 标识当前会话。适配器已经支持动态会话标头，但随包交付的路由在使用它之前，仍需要部署在用户设置中重复填写提供方专属配置。

## 决策

`dsh-llm-pi-ai` 在解析 profile 时，会把未显式设置 `sessionHeader` 的 `opencode-go` 解析为 `x-opencode-session`。显式设置的 profile 值仍然优先，因此使用其他字段名的提供方可以覆盖该默认值。适配器在模型请求中用 `GenerateOptions.sessionId` 填充解析后的字段；存在会话 id 时替换同名静态标头；直接请求没有会话 id 时省略动态字段。模型发现没有会话上下文，因此仍不发送会话标头。

该默认值是提供方协议要求，不是部署凭据或端点。提供方 profile 仍然是可选的，因此该默认值不会激活 OpenCode Go 路由，也不会把它的模型加入默认选择器；只有通过现有设置或组合层配置路由后才会生效。

## 考虑过的替代方案

**在共享 base bundle 中添加 `opencode-go` profile。** 不予采纳：这样会在每个基于 base 的 profile 中激活该路由并显示 OpenCode Go 模型，即使部署只需要其他提供方的目录。把提供方专属默认值放在 profile 解析阶段，可以保留现有的休眠路由行为。

**继续只把值放在每个部署的 `settings.yaml` 中。** 不予采纳：随包部署仍会因为固定的提供方协议要求而需要手动编辑机器本地文件。

**在请求执行路径中注入回退值。** 不予采纳：请求执行应消费已经解析的 profile，默认值应用与最终标头名称校验应由显式的 profile 解析步骤负责。

## 后果

已配置的 `opencode-go` 路由无需重复填写 `sessionHeader` 即可发送必需的动态标头；显式值和现有的静态标头冲突规则保持支持。其他提供方路由仍然没有该默认值。单元测试和真实 Loader 组合测试验证了解析、覆盖优先级，以及通过适配器发出的模型请求；包参考文档和用户指南也说明了提供方专属默认值。
