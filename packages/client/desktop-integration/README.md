---
description: "Desktop-only task-state reminders over the shell bridge: completion, approval flash, failure, and background-job notifications; for users and maintainers of the Windows desktop shell experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-desktop-integration

English | [中文](README.zh.md)

## Summary

This package turns task-state changes into desktop reminders when the Web GUI runs inside the [Windows desktop shell](../../../apps/desktop/README.md): a toast plus a short taskbar flash when a session finishes or a background job settles, a persistent taskbar flash while an approval is pending, and a critical toast when a turn fails. It observes existing client state and events through `ctx.sessions.list`, `ctx.uiSession.pendingInteractions`, and the global `api-session/error` forward; it issues no RPC, adds no session event, and never reaches a model request. Without `window.desktopBridge` (a plain browser) every action is a silent no-op, so shipping this plugin in the web profile is a build-time constant.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin as a `dsh.client` row in the web profile beside the desktop shell. The shell preload exposes `window.desktopBridge` (notify / flash / window state), and the plugin routes each trigger through it. Where the shell window's focus state matters, the plugin reads the state pushed by the shell; the strategy follows `Config` rows from cordis.yml: source switches (`notifyOnCompleted`, `flashOnApproval`, `notifyOnFailure`, `notifyOnJob`), `unfocusedOnly`, `completionMinDurationMs`, `dedupeWindowMs`, `quietHours`, and the two flash durations.

### Reminder semantics

A completed-session edge (the sidebar's green "done" mark) sends a normal toast and a short flash. A pending approval flashes the taskbar until the window regains focus; the shell clears the flash on focus. A failed turn (the host `agent/error` forward) sends a critical toast. A background job that reaches `completed`, `failed`, or `killed` sends its own toast. All toasts and flashes are skipped inside `quietHours`, deduped per category and session within `dedupeWindowMs`, and gated by `unfocusedOnly` (the default reminds only while the window is unfocused).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin holds one effect that subscribes to four existing sources: the sessions list store (completed edges and the `jobsBySession` mirror), the pending-interaction registry, and the Remote `api-session/error` event. It mirrors the host's first-observation rule for completion reminders (an already-completed row at mount arms nothing), and the `completionMinDurationMs` filter uses the client-observed run window. Every bridge call passes through the local strategy gate, and a missing bridge global short-circuits the whole plugin before any subscription is created. The copy lives in this package's `desktop-integration` locale namespace.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop shell](../../../apps/desktop/README.md) — the Electron shell exposing the bridge primitives.
- [Session Controller](../../api/session-controller/README.md) — the list store, the `jobsBySession` mirror, and the `api-session/error` forward this plugin reads.
- [Desktop integration plan](../../../docs/plans/desktop-integration.md) — the working plan (not part of the docs release tree) for the whole notification capability.

-----

<a id="model-experience"></a>
## Model Experience

None. The plugin reads existing client state and events, renders desktop notifications for a human, and never appears in a prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current reminder set. They are current package constraints, not a general notification comparison or a task backlog.

- **Cancelled turns have no global client signal** — the host forwards failures (`api-session/error`) but no cancel-only event, so a user-initiated stop does not produce a reminder; cancelled turns remain observable only on an open session's event window.
- **Windows toasts need the shell** — `notify` depends on Electron `Notification` support and the AppUserModelID the shell sets; where a toast cannot render, the bridge reports `false` and only the taskbar flash remains.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bridge contract is duplicated at the package boundary on purpose: `apps/desktop` is an application and nothing under `packages/` may depend on it, so `src/client/bridge.ts` mirrors `apps/desktop/src/bridge/contract.ts` structurally. Keep the two in lockstep when the wire contract changes.

</details>

**Runtime invariant:** No companion is published. This package is a pure consumer of the sessions list, the pending-interaction registry, and the `api-session/error` forward; it owns no state another component can observe, so there is no diverging observation to check. Its subscription teardown is proven by the HMR-safety spec.