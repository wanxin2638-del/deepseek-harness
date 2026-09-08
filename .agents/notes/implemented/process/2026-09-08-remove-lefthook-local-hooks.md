# Agent Note: Remove Lefthook local hooks

Status: implemented

English | [中文](2026-09-08-remove-lefthook-local-hooks.zh.md)

## Problem

The repository does not need a local hook manager to run its quality checks. Lefthook adds a native dependency, generated hook files, worktree configuration, an installer, and a large fixture suite around checks that CI and explicit contributor commands already own.

The bilingual merge driver is a separate Git integration. It still needs worktree-local configuration and an install-time probe, but it does not need Lefthook or commit and push hooks.

## Decision

Remove Lefthook, `lefthook.yml`, the generated local hook installer, and the hook-specific tests. The root `postinstall` script runs `scripts/install-translation-pairing.mjs`, which retains only the worktree configuration and safety checks required by the `dsh-translation-pairing` merge driver.

The repository installs no commit, merge, or push hooks. CI remains responsible for exhaustive checks, and contributors run the checks relevant to each change explicitly.

## Alternatives considered

**Keep Lefthook.** This would preserve automatic local checks but retain a native dependency and worktree-specific hook state that the repository does not need.

**Replace Lefthook with checked-in shell hooks.** This would remove the dependency but keep implicit local execution, shared hook ownership, and cross-platform hook maintenance in the repository.

**Remove all Git integration.** This would also remove automatic pairing-driver setup, so clean merges could leave generated bilingual records unresolved until a contributor runs the explicit resolver.

## Consequences

Fresh installs no longer add Lefthook or configure `core.hooksPath`. Local commits, merges, and pushes do not run repository checks automatically; the documented explicit commands and CI retain the validation signal.

The pairing merge driver remains available after installation and continues to fail closed when its runtime or owner data is unavailable. Worktree configuration support remains because Git stores the driver command per worktree.
