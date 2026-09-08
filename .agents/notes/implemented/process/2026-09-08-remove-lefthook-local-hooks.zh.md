# Agent Note: 移除 Lefthook 本地钩子

Status: implemented

[English](2026-09-08-remove-lefthook-local-hooks.md) | 中文

## Problem

仓库不需要本地钩子管理器来运行质量检查。Lefthook 会增加原生依赖、生成的钩子文件、worktree 配置、安装脚本，以及围绕 CI 和贡献者显式命令已经负责的检查而存在的大型 fixture 套件。

双语合并驱动是独立的 Git 集成。它仍需要 worktree 本地配置和安装时探测，但不需要 Lefthook，也不需要 commit 和 push 钩子。

## Decision

移除 Lefthook、`lefthook.yml`、生成本地钩子的安装器和专门的钩子测试。根目录的 `postinstall` 脚本运行 `scripts/install-translation-pairing.mjs`；该脚本只保留 `dsh-translation-pairing` 合并驱动所需的 worktree 配置与安全检查。

仓库不会安装 commit、merge 或 push 钩子。CI 继续负责完整检查，贡献者根据每次改动显式运行相关检查。

## Alternatives considered

**保留 Lefthook。** 这样可以保留自动本地检查，但也会保留仓库不需要的原生依赖和 worktree 专属钩子状态。

**用纳入版本控制的 shell 钩子替代 Lefthook。** 这样会移除依赖，却会把隐式本地执行、共享钩子所有权和跨平台钩子维护留在仓库中。

**移除全部 Git 集成。** 这样也会移除合并驱动的自动配置，使干净合并可能留下未解决的双语生成记录，直到贡献者运行显式解决命令。

## Consequences

全新安装不再添加 Lefthook，也不再配置 `core.hooksPath`。本地 commit、merge 和 push 不会自动运行仓库检查；文档中的显式命令与 CI 继续提供校验信号。

安装后仍可使用配对合并驱动；运行时或所有者数据不可用时，它仍会安全拒绝。Git 会按 worktree 保存驱动命令，因此 worktree 配置支持继续保留。
