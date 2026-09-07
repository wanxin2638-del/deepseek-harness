# Plan 2 · Desktop Integration Capability (notifications / taskbar flash, etc.)

English | [中文](desktop-integration.zh.md)

> Working plan document, not part of the `docs/` release tree: not registered as a doc-sync leaf, not projected into the website.
> Depends on [Plan 1 · Desktop shell (Electron) engineering](desktop-shell.md): this plan's bridge is provided by the shell's preload, and the plugin's product capability layer sits on top of that bridge.
> This plan follows "**everything is a plugin**": trigger-source sensing, policy, and copy are all plugin/config; the shell provides only the three primitives `notify` / `flash` / window state.

## 1. Background and goals

Once Plan 1 lands, the desktop side is functionally equivalent to "dsh web with a built-in browser". This plan adds the desktop-only value: **task-state changes → user-visible reminders**, including Windows notifications (toast) and the taskbar flash. The trigger sources are not limited to approvals (today only the in-browser composer takes over, see §4 fact G2), but a complete subset of the product event surface.

Target capabilities (ordered by value):

| # | Capability | Trigger source | User value |
|---|---|---|---|
| C1 | Task-completion reminder | Session running→idle edge (same-source signal as the sidebar "done" mark) | Know when a run finishes even while the window is unfocused |
| C2 | Pending-approval flash | `approval/request` (currently **no** OS reminder at all) | Not missed before allow/deny |
| C3 | Failure/abandon reminder | `assistant/attempt` terminal failure/cancel | Do not have to watch for the result |
| C4 | Background task/workflow/subagent completion | jobs mirror, workflow, subagent delegation | Long-task completion notification |
| C5 | Backend anomaly | Shell-level: unexpected child-process exit/restart | The user knows when the process crashes |

The trigger-source set is extensible: future webhook delivery, schedule, goal milestones, and so on register the same way (the plugin is the extension point).

## 2. Design principles (aligned with repo rules)

| Principle | Meaning |
|---|---|
| **Behavior is plugin, shell is primitive** | Trigger-source sensing, dedup, thresholds, and copy all live in the client plugin and its `Config`; Electron main has only `notify` / `flash` / window state, with no product semantics. |
| **Model-visible ⟺ logged untouched** | Reminders are presentation-only: **no new session event**, no model-visible input; trigger sources always read existing state/events. |
| **Graceful no-bridge degradation** | The plugin only takes effect when it detects `window.desktopBridge`; running the same web profile in a plain browser is a silent no-op. |
| **Copy locale-owned** | Notification title/body are product copy, routed through a typed dictionary + `t` (`packages/client/AGENTS.md` "Client UI copy is locale-owned"); no hardcoding. |
| **Policy configurable** | Each trigger's switch, threshold, and quiet hours are plugin `Config` fields from cordis.yml; not hardcoded constants. |
| **Registration is effect** | Subscriptions go through `ctx.effect()` / `ctx.on()`; unload unsubscribes (HMR-safe). |

## 3. Architecture

```
┌─ web profile Cordis tree (plugin layer, product behavior) ──────────────┐
│  dsh-desktop-integration/client (dsh.client row)                        │
│  · subscribes ctx.sessions (C1: completed edge + title projection)        │
│  · subscribes the approval client channel (C2)                            │
│  · subscribes SessionEventStream's assistant/attempt (C3)                 │
│  · subscribes the jobs mirror (C4)                                        │
│  · policy: source switches / unfocused-only / min run duration / dedup    │
│    window / quiet hours                                                   │
│  · copy: locale dictionary via t()                                        │
│  · calls window.desktopBridge (no-op when absent)                         │
└───────────────┬────────────────────────────────────────────────────────┘
                │ contextBridge (preload, contextIsolation)
┌───────────────▼────────────────────────────────────────────────────────┐
│  Electron main (primitive layer, no product semantics)                  │
│  · dsh:desktop-bridge IPC: payload validation, sender allowlist         │
│    (loopback page only)                                                 │
│  · notify({title, body, urgency}) → new Notification() (Windows toast)  │
│  · flash({mode}) / flashClear() → win.flashFrame(true/false)             │
│  · window state: focused / visible-unfocused / minimized → pushed to     │
│    the plugin                                                            │
└─────────────────────────────────────────────────────────────────────────┘
```

Bridge contract (exposed by the preload via `contextBridge.exposeInMainWorld('desktopBridge', …)`):

```ts
interface DesktopBridge {
  notify(input: { title: string; body: string; urgency: 'low' | 'normal' | 'critical' }): Promise<boolean>
  flash(mode: { kind: 'until-focus' } | { kind: 'duration'; ms: number }): Promise<void>
  flashClear(): Promise<void>
  windowState(): Promise<'focused' | 'visible-unfocused' | 'minimized' | 'hidden'>
  onWindowState(cb: (s: WindowState) => void): () => void
}
```

- main-side validation: title/body length caps, reject HTML, sender must be a loopback-page origin, single channel.
- C1's "unfocused-only" uses `windowState()`; on window refocus main calls `flashClear()` automatically (except C2, see the decision table).

## 4. Confirmed contracts (trigger-source facts · P2.0 review backfill)

> P2.0 line-by-line review: every trigger source is observable on **existing client services**; no new session event, no event stream opened for inactive sessions. Line numbers follow this repository's current implementation.

**G1 · The session-completion signal already exists** — `packages/api/session-controller/src/client/sessions/manager.ts`
- `syncCompletedNotifications()` (`:886-908`): the running→idle edge on a non-selected session enters `completedNotifications` (`:895-900`) — this is the sidebar's green "done" mark; un-running (`:897-899`); removal is dropped (`:902-907`); first observation only records the running bit (`:891-894`), and an already-idle loaded frame produces no reminder.
- List snapshot: `buildListSnapshot()` (`:910-957`) rows carry `completed` (lineage-flattened `:923`, entryCache-compared `:931-934`); the title is read through the 'title' projection (`:914-920`).
- **Subscription surface**: `service.ts:191` `readonly list: SnapshotStore<SessionListState>`; `projectList()` (`:577-647`) writes `completed` into the store rows (`:589`), `jobsBySession` in the same snapshot (`:645`); `service.ts:263` `rootCtx.reflect.provide('sessions', this, undefined)` → any client plugin can `ctx.sessions.list.subscribe()` + `getSnapshot()` (SnapshotStore semantics: `packages/client/store/src/index.ts:26-38,103-136`; the list store is a sync flush, `set` replaces the whole value).
- **C1 subscribes to the sessions list store directly and watches the `completed` false→true edge, no recompute needed**; the title uses the row's `title` (durable projection, `service.ts:587-596`).

**G2 · The approval observation point is the "pending interaction" registry, not the approval/request waterfall** — `packages/client/ui-approval` + `packages/client/ui-session`
- `PendingApproval` (`ui-approval/src/client/contract/slots.ts:69-160`): kind literal `'approval'` (`:71,95`), key `approval:<n>`, `result` settles at answer/delegate/abort (`:122-150`); `answerApproval` (`ui-approval/src/client/index.ts:35-68`) removes the pending item in finally (`:64-67`).
- **Observation channel**: `ctx.uiSession.pendingInteractions` (`ui-session/src/client/index.ts:225-231`) — a `HostObservable<ReadonlyMap<SessionId, PendingInteraction>>`, global read-only, notifies on publish (`:366-386`); `registerPendingInteraction` (`:304-323`) registers each domain. Does **not** inject the `approval/request` waterfall (`ui-approval/src/client/index.ts:90-92`) — avoids coupling to the ui-approval answer-listener order.
- **C2 subscribes to pendingInteractions: a `kind === 'approval'` item appearing → `flash until-focus`; its disappearance (handled/abandoned/invalid) → clear.**

**G3 · Failures have a ready global forwarded event; no per-session stream needed** — `packages/api/session-controller/src`
- Host side: `src/index.ts:148-150` `ctx.on('agent/error', ({agent,error}) => ctx.emit('api-session/error', agent.id, errorChain(error)))` — `agent/error` is terminal Agent failure (retry is in-loop behavior and does not trigger it); `:171` background-activation failure forwards the same way.
- Client side: `src/client/index.ts:110-112` `ctx.remote.$on('api-session/error', (sessionId, message) => …)` — pure notification (no next()), **any client plugin can subscribe equally**; `api-session/status` (`:104-106`) / `added` (`:102`) / `removed` (`:103`) are the same family.
- Persistent terminal-state fact: `packages/core/session/src/types.ts:276` `'turn/end': { turn, reason }`, reason measures (`:192-213`): `error` (structured LlmFailure) / `aborted` / `completed` / `blocked` / `max-tokens` / `interrupted`; `'assistant/attempt'` (`:313`) records only failed/retried/cancelled attempts without a surface message.
- **C3 uses `api-session/error`**: failure notification (title from the list row title, body from the message); retry does not trigger. **Cancellation makes no global notification**: the host has no cancel-forward event (`turn/end aborted` is visible only in an open session's event window), listed as a known limitation and future extension point. Per-session event-window cost: `SessionEventStream` (`transport.ts:136-217`) opens `session.follow` per address and pulls the history page; opening a stream per inactive session scales linearly, so it is not used.

**G4 · The background-jobs mirror is in the list snapshot** — `packages/api/session-controller/src`
- `SessionJob` (`src/types.ts:527-535`): `{ id, kind, label, status: 'running'|'stopping'|'completed'|'killed'|'failed', detail?, startedAt, finishedAt? }`; the host pushes a control frame `{type:'jobs', sessionId, jobs}` (`:556`), mirrored into the `jobsBySession` list snapshot (`manager.ts:954`, `service.ts:84,645`).
- **C4 subscribes to `ctx.sessions.list` and tracks a job's status in `jobsBySession[sessionId]` → 'completed'|'killed'|'failed' edge** (`finishedAt` corroborates); title = session title, body = job label; same source as the `ui-jobs` display.

**G5 · Configuration surface**
- User settings: `packages/settings/settings-file` (`$DSH_HOME/settings.yaml`, hot reload) + `packages/api/settings-controller` (web-app patch row `cordis.patch.yml:96-97`); adding a settings domain must go through settings-controller registration (P2.4 re-checks the exact API).
- **Default is the plugin `Config` (cordis.yml) this round**: the web profile's assembly patch is `packages/bundle/web-app/cordis.patch.yml`, and the home-layer hot-reload patch is `$DSH_HOME/cordis.patch.yml` (Plan 1 F8) — P2.2's `dsh.client` row can land in the assembly patch (ships with the package) or the home layer; P2.4 is an optional settings-UI increment.

**G6 · Locale and test surfaces**
- Notification copy: the new plugin carries its own dictionary (`src/client/locales.ts`, zh is the key source with en key-identical; pattern like `ui-approval/src/client/locales.ts`), via `ctx.locale.register(NS, { zh, en })`; `verify-client-ui-i18n` enforces it.
- Testing: a product-user-visible change needs snapshot/REAL coverage (`docs/testing.md`); a pure client plugin with no browser UI needs a non-unit REAL-composition test per `packages/AGENTS.md`. Notifications are an OS-side side effect with no keyless recordable surface → P2.2 boots the web profile through the Loader + injects a fake bridge, and asserts the "trigger source → bridge call" sequence as a behavior assertion instead of a snapshot.

## 5. Decision table

| # | Decision | Options and recommendation | Basis |
|---|---|---|---|
| D1 | Sensing-layer location | **client plugin** (`dsh.client` row), into the web profile; no fork of any official bundle, insert a row via the profile's `cordis.patch.yml` (home-layer hot reload) or an overlay bundle | Everything is a plugin; G1 |
| D2 | Bridge is primitives-only | main carries no product semantics, only notify/flash/windowState | The shell is the host (Plan 1 §2) |
| D3 | C1 determination signal | use the `completed` edge directly (G1); no shell polling, no recompute | G1; avoid reimplementation |
| D4 | C2 flash semantics | `flash({kind:'until-focus'})`: **flash continues until the user handles the approval**; cleared only on window focus; C1/C3/C4 use `duration`-type flash + notification | An approval must not be missed; a completion notification is once |
| D5 | Quiet hours | plugin `Config` provides `quietHours` (configurable); during them notify returns false and no flash happens | Policy-configurable principle |
| D6 | No-bridge degradation | `window.desktopBridge` missing → plugin no-op; the same web profile still runs in a plain browser | Both environments consistent |
| D7 | Copy | notification title/body enter the locale dictionary via `t()` | locale-owned rule |

## 6. Task breakdown

Common convention: depends on Plan 1's P1.3/P1.5 for a bridge-usable dev shell; each task ends with a `git commit` (message carries P#) and updates this file's §8 status table.

### P2.0 Contract review (read-only)
- Write path: this file only (§4 fact-table backfill).
- Review checklist:
  1. G2: `ui-approval`'s **exact client API** for subscribing to `approval/request` (scoped Remote form, store/channel name), confirm a client plugin can inject the same channel; confirm the "approval pending" determination state.
  2. G3: `assistant/attempt` event payload's terminal-state discriminant fields (failed/retried/cancelled), confirm the filter that avoids false positives during retry; SessionEventStream's subscription cost for inactive sessions.
  3. G4: jobs mirror / workflow / subagent client subscription APIs and completion determination.
  4. G5: the minimal change surface for adding one settings-domain namespace (settings-file + api-settings-controller + ui-settings row).
  5. locale: the existing structure of the dictionary hosting notification copy and the flow for adding an entry (`verify-client-ui-i18n`).
  6. Test surface: `docs/testing.md`'s snapshot requirement for product-user-visible changes; whether notification output has a recordable keyless snapshot channel (if not, record the substitute: REAL-composition assertions on the bridge-call sequence).
- Acceptance: §4 fact table backfilled with exact APIs and line numbers; undecided items marked with a probe method; `git commit`.
- Result: the fact table is backfilled (see §4 G1–G6); two conclusions correct the original placeholders: C2's observation point becomes `uiSession.pendingInteractions` (avoids waterfall-order coupling), C3 becomes the global `api-session/error` (cancel notification listed as a limitation); `git commit` done.

### P2.1 Bridge-contract landing (main + preload)
- Write path: `apps/desktop/src/main.ts`'s IPC handling, `apps/desktop/src/preload.ts`.
- Points:
  - Implement per the §3 bridge contract; `contextBridge` + `contextIsolation: true`; payload validation (length, enum, reject HTML); sender allowlist (only `http://127.0.0.1:*`).
  - main side: `Notification` (Windows toast, `app.setAppUserModelId` guarantees toast attribution), `win.flashFrame`, window `focus`/`minimize`/`blur` state push, `flashClear` linked to window focus (except C2's until-focus).
  - Unit tests: IPC validation and the state machine are covered with a mocked BrowserWindow/Notification; real-machine behavior is P2.5.
- Acceptance: in the dev shell `window.desktopBridge` exists, `notify` pops a toast, `flash` flashes the taskbar; invalid payloads rejected; non-loopback senders rejected.
- Risk: Windows toast depends on `app.setAppUserModelId` and the `Notification.isSupported()` probe; where unsupported, `notify` returns false.

### P2.2 Client-plugin implementation (sensing + policy)
- Write path: `packages/client/desktop-integration/` (new package, P2.0 conclusion: independent workspace package) or `apps/desktop/plugins/`.
- Points:
  - Subscriptions: `ctx.sessions` list (C1, `completed` edge + `title` projection), the approval channel (C2), `SessionEventStream` (C3, terminal failure/cancel), the jobs mirror (C4).
  - Policy: source switches / unfocused-only / `completionMinSeconds` / dedup window / `quietHours`, all `Config` fields.
  - Bridge calls: `window.desktopBridge` missing → no-op; copy via `t()`.
  - Lifecycle: register/unsubscribe via `ctx.effect()`; HMR-safe.
  - No model-visible input: no new session event.
- Acceptance: a REAL-composition test (Loader boots the web profile + injects a fake bridge) asserts the mapping from each trigger source to a bridge call; zero calls with no bridge; subscriptions removed after HMR dispose; `verify-client-ui-i18n` passes.
- Result: `packages/client/desktop-integration` (`@deepseek-ai/dsh-client-desktop-integration`) lands; C1/C2/C3/C4 are all verified by behavior tests on the client test runtime (16 cases), including no-bridge no-op and HMR subscription removal; `verify-client-ui-i18n` / `verify-client-packages` / `verify-package-dependencies` pass; an Agent Note records the bridge and reminder decisions.
- Risk: the approval/jobs subscription APIs do not match the P2.0 conclusion → backfill the fact table and adjust.

### P2.3 Desktop-shell embedding (packaging integration)
- Write path: `apps/desktop` assembly/packaging config (plugin into the dsh-runtime closure + profile patch row).
- Points:
  - The plugin package enters the assembly dependency closure; on `apps/desktop` first start, insert the `dsh-desktop-integration` row into the profile/home-layer patch in `$DSH_HOME` (userData/dsh-home) (home-layer hot reload, no web-app bundle fork).
  - After packaging, verify the in-shell C1 trigger: finish a short task → toast + flash.
- Acceptance: the notification chain works fully inside the exe; the plugin is a no-op when the same web profile is opened in a plain browser with the same DSH_HOME.

### P2.4 Settings UI (optional increment)
- Write path: `packages/client/ui-desktop-integration/` + a settings domain.
- Points: a `desktop-integration` settings namespace (source switches, quiet hours, minimum duration), one ui-settings row; defaults match `Config`.
- Acceptance: the settings page edits and persists to `settings.yaml`, hot-reload takes effect; full locale.
- Result: **deferred as a whole (per the plan's "deferrable" strategy)**. First only `Config` (P2.2 already carries every policy switch and `quietHours`), so quiet hours etc. can be configured directly in cordis.yml; the settings UI is a later increment that mounts a host settings row when reused.

### P2.5 Real-machine verification
- Write path: `docs/plans/notes/verification-integration.md` (new).
- Checklist:
  1. C1: minimize the window → a session runs out → toast + short flash; no disturbance in the focused state.
  2. C2: switch the window away → an approval is pending → persistent taskbar flash; stops after returning and handling.
  3. C3: a tool terminal failure → failure notification; no notification during retry.
  4. C4: a background job completes → notification.
  5. Quiet hours: no notification, no flash.
  6. No-bridge environment (plain browser): behaves exactly like the official web (zero difference).
  7. Copy: notification copy is correct after switching between zh and en.
- Acceptance: evidence recorded for each item; functional defects return to the corresponding task for a fix and re-verify.

## 7. Non-goals

- No system-level "do-not-disturb" integration (Windows Focus Assist detection) — start with in-plugin `quietHours`.
- No notification-click → jump-to-session (Electron `Notification` click callback is possible, listed as future).
- No new trigger sources such as webhook delivery, schedule, goal milestones — they come later via the same plugin pattern, not this round.
- No agent-loop change, no session-log change, no new session event.

## 8. Status table

| Task | Status | Date | Notes |
|---|---|---|---|
| P2.0 Contract review | done | 2026-09-07 | §4 G1–G6 backfilled with exact APIs/lines; C2/C3 observation-point conclusions corrected (see §6 P2.0 result) |
| P2.1 Bridge-contract landing | done | 2026-09-07 | single channel `dsh:desktop-bridge` + pure validation/flash state machine (18 unit tests); `lib/preload.cjs` CJS preload (sandbox-constrained); CDP probe measured: `window.desktopBridge` has all five methods, notify=true, flash/flashClear/windowState all pass |
| P2.2 Client plugin | done | 2026-09-07 | `packages/client/desktop-integration` + web-app `dsh.client` row; 16 behavior tests + no-bridge/HMR; i18n/client-packages/deps gates pass; see §6 P2.2 result and the Agent Note |
| P2.3 Packaging integration | done | 2026-09-07 | `deploy-root` closure adds the `dsh-client-desktop-integration` row; after `assemble` re-assembly (213.5 MB) `probe-roster` measured: the `__DSH_BOOT__` roster carries the row; shell-start `probe-bridge` passes fully in the assembled state; `verify-cordis-config` passes after the tsconfig.base.json path mapping (only the pre-existing `apps/cli/tests/profiles/acp/cordis.yml` fixture fails, not from this branch) |
| P2.4 Settings UI | deferred | 2026-09-07 | deferred as a whole per the plan's "deferrable" strategy (see §6 P2.4 result); policy is all provided by `Config` |
| P2.5 Real-machine verification | done | 2026-09-07 | [notes/verification-integration.md](notes/verification-integration.md): model-driven items (C1–C4 real triggers) marked "awaiting re-verification/steps" due to no key; primitive and assembly surfaces (bridge/CDP, roster, quiet hours, no-bridge, copy) verified on the behavior surface |

## 9. Risk summary

| Risk | Impact | Mitigation |
|---|---|---|
| approval/jobs client subscription APIs differ from expectations | C2/C4 delayed | P2.0 front-loaded review, backfill the fact table |
| Windows toast support differences (no AppUserModelID / unsupported) | C1/C3/C4 notifications fail | `Notification.isSupported()` + AppUserModelID + P2.1 probe; the flash still works |
| Notification spam (long sessions, many completions) | poor experience | dedup window + unfocused-only + minimum duration (Config) |
| The plugin differs in a plain browser | dual-environment behavior drift | no-bridge no-op (D6) verified in P2.5-6 |
| Locale full-set new-copy workload | P2.2 size | P2.0 maps the structure; translation follows the existing bilingual flow |
