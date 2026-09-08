# Agent Note: Session extra writable roots

Status: implemented

English | [中文](2026-09-08-session-extra-writable-roots.zh.md)

## Problem

Development sessions often use a Git worktree outside the Session workspace. The existing `workspace-write` policy grants the Session cwd and backend temporary areas, so tools repeatedly require authorization for the worktree even when the operator intentionally isolates changes there.

## Decision

`dsh-sandbox-policy` owns a session-scoped `sandbox/writable-root` event and `sandboxWritableRoots` projection. The event stores canonical existing directory roots with `add` and `remove` actions; the `/sandbox-path` human command and the Web directory editor use this write path. The primary Session cwd remains an implicit writable root, and extra roots are carried on `SandboxExecutionPolicy.extraWritableRoots` for every subsequent confined call.

All enforcing families consume the same roots. The in-process filesystem fence, bwrap, Landlock, Seatbelt, and Windows ACL grant materialization include extra roots under `workspace-write`; `read-only` and `danger-full-access` keep their existing meanings. Paths outside the effective roots continue through the existing denial and approval flow. The model-visible sandbox context names the extra roots so the logged runtime snapshot describes the policy used by later calls.

The Web client renders an additional-root editor beside the Session View tabs. The primary workspace is not removable, while the editor adds existing directories through the Host picker or an absolute path and removes session-owned extra roots. Root changes are durable Session events and replay through the normal projection baseline.

## Alternatives considered

**A global allowlist.** Rejected because a directory authorized for one development Session must not silently expand another Session's file authority.

**A new full-access permission preset.** Rejected because it would widen the entire process policy and bypass the existing outside-root approval behavior.

**File-level grants.** Deferred because the shipped workflow is Git worktree directories; exact file grants require different guarantees for in-process writes, atomic replacement, shell commands, and platform ACL or path-rule backends.

**UI-only state.** Rejected because execution must enforce the decision in trusted Host code and resumed Sessions must reconstruct the same policy from durable events.

## Consequences

The policy carrier now supports one primary workspace root plus any number of session-owned extra directory roots. Existing mode selection, approval policy, temporary-root behavior, and outside-root denial remain unchanged. A removed or missing extra directory does not grant a replacement path; a new grant requires a Host-validated existing directory. Already-running persistent processes keep the policy stamped when they started and must be restarted to observe later root changes.

## Testing

Focused coverage pins projection replay, canonical directory validation, add/remove idempotency, model-context rendering, path-root derivation, platform profile arguments, filesystem containment, invariant rejection, Web editor commands, and slot registration disposal.
