# Agent Note: Desktop shell bridge and task-state reminders (notify / taskbar flash)

Status: implemented

English | [中文](2026-09-07-desktop-bridge-and-task-reminders.zh.md)

## Problem

The Windows desktop shell ([apps/desktop](../../../../apps/desktop/README.md), Plan 1) hosts the web profile; before this change it owned no OS-level attention primitives. Task-state changes reached the user only while the window was focused: a completed session lit the sidebar's green "done" mark in-page, and a pending approval was answerable only inside the composer takeover. An unfocused window let completions pass silently and left approvals unanswered. The new capability is "task state change → user-visible reminder" with three shell primitives — toast, taskbar flash, window state — and zero product semantics in the shell.

## Decision

**The shell exposes three primitives over one IPC channel; every trigger, strategy, and wording lives in a web-profile client plugin.**

1. **Bridge contract** (`apps/desktop/src/bridge/contract.ts` + `preload.cjs`): one channel `dsh:desktop-bridge` carrying `notify({title, body, urgency})`, `flash(until-focus | duration)` , `flashClear()`, and `windowState()`; the main half validates sender origin (loopback pages only), payload shape, and length caps, and rejects tag-like text. The renderer global is `window.desktopBridge`, exposed by a CommonJS preload (sandboxed preloads cannot use ESM — `src/preload.cjs` is copied to `lib/preload.cjs` at build).
2. **Flash semantics** (`FlashController`): window focus clears every flash; `until-focus` has no timer, `duration` self-clears. A newer flash supersedes the active one. The window's `closed` event removes the IPC handler, focus listener, and pending timer; the shell adapter checks `isDestroyed()` before calling `flashFrame`. Cleanup stays on `closed` because `close` can be cancelled.
3. **Plugin** (`@deepseek-ai/dsh-client-desktop-integration`, a `dsh.client` row in the web profile): observers ride existing client channels — the sessions list store for `completed` edges (C1) and the `jobsBySession` mirror (C4), the pending-interaction registry for all user interactions (C2), and the global `api-session/error` forward for failures (C3). Every action passes the plugin's `Config` strategy (source switches, `unfocusedOnly`, `completionMinDurationMs`, `dedupeWindowMs`, `quietHours`, flash durations); without `window.desktopBridge` the plugin short-circuits before creating any subscription (a plain browser is unaffected). The C2 scope and focus-transition handling are recorded in [the pending user-interaction reminder note](../bug-fix/2026-09-08-all-pending-user-interactions-trigger-desktop-attention.md).
4. **C2 observes the pending-interaction registry, not the `approval/request` waterfall** — `uiSession.pendingInteractions` is a read-only global observable, so the plugin needs no ordering relationship with the ui-approval responder.
5. **C3 uses the global `api-session/error` forward, not per-session event streams** — the host emits it on terminal `agent/error`; opening a `SessionEventStream` per non-active session (each pulls history pages) was cost-prohibitive.
6. **Windows toasts** require `app.setAppUserModelId` before `Notification` creation; `notify` returns `false` when `Notification.isSupported()` is off.

### Non-goals recorded

Cancelled turns get no global reminder this round: the host forwards failures but no cancel-only event, and `turn/end` `aborted` reasons are visible only on an open session's event window. Notification click-through navigation is future work. No session event is added and no model-visible input changes.

## Alternatives considered

- **Subscribe the plugin to the `approval/request` Remote waterfall** — rejected: listener order relative to ui-approval's responder decides who answers; the pending-interaction registry already publishes exactly the "waiting for the human" fact.
- **C3 over per-session `SessionEventStream`s** — rejected: each stream opens a `session.follow` connection and history pages, linear cost per non-active session.
- **ESM preload** — rejected: Electron loads sandboxed preloads as CommonJS only.
- **Product logic in the shell** — rejected by the Plan 1/Plan 2 split: the shell stays primitive-only, the plugin owns behavior.

## Consequences

- The bridge contract is duplicated at the package boundary on purpose: `packages/` may not depend on `apps/desktop`, so `src/client/bridge.ts` mirrors `apps/desktop/src/bridge/contract.ts` structurally; the two must change together.
- The same web profile now ships the reminder plugin in every environment; in a plain browser it is a no-op by construction (D6).
- A long failure message is truncated before the bridge cap; the shell validates, the plugin truncates.
- Quiet hours suppress toasts and flashes alike; pending-interaction flashes are included.
- The shell auto-clears any flash on window focus, so a focused window never keeps flashing; `until-focus` is the pending-interaction path where the plugin also explicitly clears when the pending item disappears.

## Testing

- Bridge unit tests (`apps/desktop/tests/`): request validation matrix, origin whitelist, flash state machine (fake timers), dispatch and disposal against a mocked `ipcMain`; the CDP probe script (`apps/desktop/scripts/probe-bridge.mjs`) verifies the real renderer against a live shell (bridge present, `notify` → `true`, `flash`/`flashClear`/`windowState`).
- Plugin tests (`packages/client/desktop-integration/tests/`): trigger→bridge mapping over the client test runtime (real Cordis ctx, real ui-session, TestSessions double) — completed edge, first-observation baseline, unfocused gating, `completionMinDurationMs`, approval/question/plan-review flashes + release, focus-transition recovery, failure notify + dedupe + quiet hours, job transitions, no-bridge no-op, HMR disposal removing every subscription, and zh/en copy parity.
- Gates: `verify-client-ui-i18n`, `verify-client-packages`, `verify-package-dependencies`, client aggregate typecheck, translation pairing.
