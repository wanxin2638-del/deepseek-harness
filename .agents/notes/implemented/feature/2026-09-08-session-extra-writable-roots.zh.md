# Agent Note: 会话额外可写根目录

Status: implemented

[English](2026-09-08-session-extra-writable-roots.md) | 中文

## Problem

开发会话经常使用位于 Session 工作区之外的 Git worktree。现有 `workspace-write` 策略只授权 Session cwd 与后端临时目录，因此即使操作者明确把改动隔离在 worktree 中，工具仍会反复要求授权。

## Decision

`dsh-sandbox-policy` 负责会话级 `sandbox/writable-root` 事件与 `sandboxWritableRoots` projection。事件使用 `add` 与 `remove` 操作记录已规范化且已存在的目录根；`/sandbox-path` 人工命令与 Web 目录编辑器都通过这条写入路径。Session 的主要 cwd 仍是隐式可写根，额外根目录通过 `SandboxExecutionPolicy.extraWritableRoots` 传给之后的每次受限调用。

所有强制执行家族消费同一份根目录。进程内文件系统围栏、bwrap、Landlock、Seatbelt 与 Windows ACL 授权物化都会在 `workspace-write` 下包含额外根目录；`read-only` 与 `danger-full-access` 保持既有含义。有效根目录之外的路径继续走现有拒绝与授权流程。模型可见的沙箱上下文会列出额外根目录，因此后续调用使用的策略可以由日志中的运行时快照重建。

Web 客户端在 Session View 标签右侧渲染额外根目录编辑器。主要工作区不可移除；编辑器支持通过 Host 目录选择器或绝对路径添加已存在目录，也支持移除会话拥有的额外根。根目录变化是持久 Session 事件，并通过正常 projection baseline 回放。

## Alternatives considered

**全局授权列表。** 否决：一个开发 Session 授权的目录不应静默扩大另一个 Session 的文件权限。

**新的完全权限预设。** 否决：这会扩大整个进程策略，并绕过现有工作区外的授权行为。

**文件级授权。** 延后：已交付工作流针对 Git worktree 目录；精确文件授权需要分别定义进程内写入、原子替换、shell 命令以及各平台 ACL 或路径规则后端的保证。

**只保存 UI 状态。** 否决：执行必须在受信任的 Host 代码中强制实施，恢复的 Session 也必须从持久事件重建相同策略。

## Consequences

策略载体现在支持一个主要工作区根目录以及任意数量的会话额外目录根。既有模式选择、授权策略、临时根目录行为与工作区外拒绝行为保持不变。被移除或已不存在的额外目录不会授权替代路径；新增授权必须经过 Host 校验并要求目录已存在。已经运行的持久进程继续使用启动时固化的策略，之后的根目录变化要在重启进程后生效。

## Testing

定向覆盖固定了 projection 回放、目录规范化校验、添加/移除幂等性、模型上下文渲染、根目录推导、平台 profile 参数、文件系统围栏、异常不变量拒绝、Web 编辑器命令以及 slot 注册释放。
