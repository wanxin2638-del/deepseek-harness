# Desktop Integration Capability · Real-Machine Verification Record (P2.5)

English | [中文](verification-integration.zh.md)

> Working verification document, not part of the `docs/` release tree. Corresponds to [Desktop Integration Plan](../desktop-integration.md) P2.5.

> Convention: on a machine without `DEEPSEEK_API_KEY`, only the primitives and the assembly surface can be verified; model-driven items are recorded as "unverified + reason + reproduction steps".

## 0. Verification environment

- Machine: Windows (dev shell runs the assembled backend from `.runtime`, Chrome DevTools port 9223).
- Versions: `apps/desktop` (P2.1 bridge) + `@deepseek-ai/dsh-client-desktop-integration` (P2.2 row) + web-app bundle patch (P2.3).
- No model key on this machine: the model-driven items (real triggers of C1/C2/C3/C4) need the user to configure a key, then re-verify by the steps.

## 1. C1 task-completion reminder

- Steps (need a key): minimize the window → submit a short task in a new session → wait for the "done" mark → expected: toast (locale copy) + 4s taskbar flash; returning to the window does not re-disturb.
- No-key evidence: the completed-edge → bridge-call mapping is covered by the P2.2 behavior tests (`completed` edge notification + duration flash); the bridge's real notify/flash behavior passes in the §5 primitive verification.
- Status: **not fully verified (missing key)**; the mapping and the bridge are verified separately.

## 2. C2 pending-approval flash

- Steps (need a key): trigger a tool call that requires approval → switch away from the window → expected: persistent taskbar flash until you return and handle it; stops after handling (allow/deny).
- No-key evidence: pending → until-focus flash, disappearance → flashClear, covered by the P2.2 behavior tests; a real pending interaction needs a real approval request.
- Status: **awaiting key re-verification**.

## 3. C3 failure reminder

- Steps (need a key): submit a task that is guaranteed to fail (for example, calling a nonexistent tool name) → expected: critical toast + 8s flash; retry does not distribute.
- No-key evidence: `api-session/error` → notify(urgency critical) + flash, covered by the P2.2 behavior tests.
- Status: **awaiting key re-verification**.

## 4. C4 background-job completion

- Steps (need a key): send a long `run_in_background` task → expected: toast + flash when the job turns `completed`.
- No-key evidence: `jobsBySession` state transition → notify, covered by the P2.2 behavior tests (one each for completed/failed/killed).
- Status: **awaiting key re-verification**.

## 5. Bridge-primitive real-machine verification (P2.1 reuse)

- Command: `pnpm --filter @deepseek-ai/dsh-desktop start -- --remote-debugging-port=9223`, then `node apps/desktop/scripts/probe-bridge.mjs --port 9223`.
- Result (measured 2026-09-07):

```
[ok] bridge present: {"present":true,"methods":["flash","flashClear","notify","onWindowState","windowState"]}
[ok] windowState: "visible-unfocused"
[ok] notify: true
[ok] flash duration: "ok"
[ok] flashClear: "ok"
```

- Meaning: `window.desktopBridge` has all five methods; `notify` goes through a real `Notification` (true = toast dispatched); `flash`/`flashClear` call `win.flashFrame`; the window-state push is ready.
- Rejection of invalid payloads / non-loopback senders is covered by the bridge unit tests (`apps/desktop/tests/bridge-ipc.main.spec.ts`).

## 6. Quiet hours

- No-key evidence: when `quietHours` matches the current hour, notify/flash are all skipped (P2.2 behavior tests); the C2 approval flash is suppressed as well.
- Status: verified (behavior surface).

## 7. No-bridge environment (plain browser)

- Expected: the same web profile in a plain browser behaves exactly like the official web (plugin no-op, D6).
- Evidence: the plugin short-circuits before initialization when `window.desktopBridge` is missing (P2.2 `no bridge` test); the web profile assembly carries the row but the browser side has no side effects.
- Status: verified (behavior surface).

## 8. Copy

- Expected: notification title/body are correct after switching between zh and en.
- Evidence: the P2.2 copy tests assert zh/en output and an identical key set; `verify-client-ui-i18n` passes.
- Status: verified (behavior surface).

## 9. Assembly integration (P2.3)

- `.runtime/node_modules/@deepseek-ai/dsh-client-desktop-integration/lib/client.js` exists in the assembly closure (P2.3 measurement pending).
- The shell startup log shows no row import error; the page boots normally (P2.3 measurement pending).
