# Plan 1 · Desktop shell (Electron) engineering

English | [中文](desktop-shell.zh.md)

> Working plan document, not part of the `docs/` release tree: not registered as a doc-sync leaf, not projected into the website.

> Companion to [Plan 2 · Desktop integration capability](desktop-integration.md) (notifications/taskbar flash, etc., which depends on this plan landing).

> This plan only makes "shell = host"; it makes no product logic.

## 1. Positioning and goals

Turn the official DSH into a Windows desktop exe. The current product form is `dsh --profile web` serving a complete Web GUI (pages + `/api` RPC + event stream + static UI) on `127.0.0.1`. Target form:

- A **double-click-to-use** Windows x64 portable exe (green, no-install single file).
- **Fully embedded**: the exe contains the Electron shell, the Node runtime, and the dsh backend assembly (`lib` + `node_modules` + UI dist).
- **Zero environment requirement on the recipient**: no Node / pnpm / Python / git; Windows 10/11 x64 suffices (dsh's shell tool on Windows goes through the system PowerShell, see §3 fact F9).
- **Integrated**: the shell starts the backend automatically, completes the login exchange automatically, and cleans up the whole child-process tree on exit.

## 2. Design principles (aligned with repo rules)

| Principle | Meaning |
|---|---|
| **The shell is a host, not a plugin** | The `webserver` package JSDoc already defines Electron as a host (`packages/host/webserver/src/index.ts:4`). The shell makes no product logic; it only orchestrates: spawn, readiness parsing, login, navigation constraints, exit cleanup. |
| **Obey the application-launch rule** | Any Node application may be started only through the `dsh` CLI plus a named profile (`docs/architecture.md#application-launch`, the `verify-application-entrypoints` gate). The shell must `spawn(<node>, [<lib/bin.js>, '--profile', 'web', ...])`; building a Node entry of its own is forbidden. |
| **Everything-is-a-plugin unchanged** | Product capability (notifications, taskbar flash, etc.) is all left to Plan 2's plugin layer; the shell exposes only the thinnest bridge. This plan implements no "task-state" sensing. |
| **Go through the http loopback, not file://** | Authentication (token→cookie), the browser-trust fence, and `/api` are all designed around the http origin (Origin `null` is rejected, fact F5). The shell uses `loadURL(token URL)` for the exchange; Electron's default session persists the cookie. |

## 3. Confirmed contracts (decision facts)

All of the following are verified line by line in this repository's source and serve as the only fact source for P1.2–P1.5.

**F1 · Ready line** — `packages/bundle/web-app/src/index.ts:280` prints `dsh web: http://127.0.0.1:<port>/?token=<base64url>`
- It prints after the Loader tree settles (`:263-305`), i.e. after sibling rows such as `/api` have mounted; receiving the line means GET/RPC is available.
- `printUrl: true` is hardcoded in the web bundle patch (`packages/bundle/web-app/cordis.patch.yml:140`).
- The ` (LAN: <url>)` suffix is appended only when a LAN address exists; LAN appears only with `--host 0.0.0.0`, which is rejected (F3), so there is in practice no LAN suffix. Shell parsing: scan stdout lines, match the `^dsh web: ` prefix and take the first `http://...` token; do not assume it is the first line (boot/telemetry logs may precede it).

**F2 · Login exchange** — `packages/client/connection/src/browser-auth.ts`
- token: process-level one-shot, base64url 32 random bytes, held by a per-process root WeakMap (`:52-58`); `authenticatedUrl` appends `?token=` (`:223-230`).
- `GET /` with the token → `303` + `location: /` + `Set-Cookie` (HttpOnly, SameSite=Strict, bound to the Host authority, `:256-263, :70-78, :289-302`) → lands on a clean home page.
- Cookie name `dsh-auth-<sha256(authority)>`, lifetime `cookieMaxAgeDays`, unconfigured in the web profile → schema default **30 days** (`packages/client/connection/src/index.ts:88-91`).
- **`/api` recognizes only the cookie**: `requestRejection` runs the Host/Origin fence before `isAuthenticated` (`packages/client/connection/src/rpc-host.ts:97-100`). The query token only authenticates the index; it cannot RPC directly. The shell must complete one `loadURL(token URL)` exchange.

**F3 · Flags** — `packages/bundle/web-app/src/startup.ts:46-87`
- `--no-open` (suppresses the default-browser spawn; the shell **must pass it**, otherwise the backend starts a browser opener via `process.execPath --eval`, `:182-191`); `--port <n>` (`0` = OS-assigned); `--host <h>`; `--trusted-host`.
- **`--host 0.0.0.0` is rejected at startup** (`:74-76`). Default host `127.0.0.1`, default port 3080 (patch lazy expression `cordis.patch.yml:120-121`).

**F4 · env chain and DSH_HOME** — `packages/boot/app-boot/src/index.ts:198-216`、`packages/util/home-paths`
- Read chain: inherited process.env > the invocation directory's `.env` > `$DSH_HOME/.env`; lower layers do not override higher ones.
- **`DSH_HOME` is bootstrap-only; no `.env` can set it** — the shell must explicitly inject `env: { DSH_HOME: <userData>/dsh-home }`. Default `~/.dsh`.
- `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` may be declared in `.env`; the shell **injects** no `DEEPSEEK_*` (key bootstrap is the Web UI's own concern, see the Plan 2 contract basis).

**F5 · browser-trust fence** — `packages/client/connection/src/api-request-trust.ts:91-118`
- The Host must be loopback or a declared trustedHost; `sec-fetch-site: cross-site` is rejected; if Origin exists it must equal Host; **Origin `null` is rejected** (disables `file://`, sandboxed iframes). Electron renderer passes same-origin fetch to loopback natively; keep `webSecurity` on by default.

**F6 · Assembled UI static assets** — `packages/bundle/web-app/src/index.ts:171-179`
- `resolveDistIndex()` anchors at `@deepseek-ai/dsh-web-frontend/package.json`'s neighbor `dist/index.html`; that package is a dependency of `@deepseek-ai/dsh-web-app`. The assembly works as long as the dependency closure carries that package and it contains `dist/index.html`.

**F7 · Startup chain** — `apps/cli/package.json`
- `@deepseek-ai/dsh`, `"bin": { "dsh": "lib/bin.js" }`, `files: ["lib/*.js"]`, ESM.
- Source state (in-repo `pnpm dsh`) goes through the tsx ESM hook; **the assembled `lib/bin.js` is a plain compiled artifact, run directly with `node lib/bin.js`, no tsx dependency** (P1.4 measured re-check).

**F8 · Profile mechanism** — `packages/boot/app-boot/src/profile.ts`
- Profile directory `$DSH_HOME/profiles/<name>`; the `web` template = bundles `[dsh-base, dsh-web-app]`, `patchReload: live` (`:137-158`).
- `dsh plugin --profile web add <pkg>` can add an out-of-tree plugin; `$DSH_HOME/cordis.patch.yml` is the home-layer patch (hot reload). Injecting `DSH_HOME` before the shell's first start lets `dsh --profile web` initialize that directory automatically.

**F9 · Windows runtime surface**
- The web profile on win32 **turns off bash, turns on pwsh** (`packages/bundle/base/cordis.patch.yml:220-258`).
- `dsh-pwsh-local` auto-discovery: when `pwshPath` is unset it checks the Windows install path, including **Windows PowerShell 5.1 (powershell.exe)**, then falls back to `pwsh` on the PATH (`packages/shell/pwsh-local/src/index.ts:72-77`). → a clean Win10/11 needs **no extra install**.
- code-runtime is not in the web profile → **no Python needed**.

**F10 · Native dependencies (assembly ABI risk)** — `pnpm-workspace.yaml allowBuilds`
- The runtime closure contains native modules: `koffi` (JSONL `MoveFileExW` write-through release), `fs-ext` (session write-lock `LockFileEx`), `node-addon-require-builtin` (win32-x64-msvc prebuild). `node-pty` (PTY) is not in the web-profile closure.
- **P1.4 measurement ruling D2 (this line replaces the old prediction)**: system Node v24.0.0 (ABI 137) runs the assembled `lib/bin.js` → ready line + `GET /` 401 + no `ERR_DLOPEN` at all, probe passes. Electron 44.2.0's built-in Node v24.20.0 (ABI 149) under `ELECTRON_RUN_AS_NODE=1` runs the same closure → `fs-ext` fails on load with `ERR_DLOPEN_FAILED` (`NODE_MODULE_VERSION 149`, nan+node-gyp non-N-API, stack at `fs-ext.js:22`). `koffi` (cnoke `"napi": 8`) and `node-addon-require-builtin` (N-API prebuild) do not error, so the ABI-compatibility conclusion holds. → **the D2 first choice does not hold; fall back to a standalone node.exe** (shell packaging path `resources/node/node.exe`, already implemented that way in P1.5, size +~50MB).

**F11 · App-layer minimum file surface and root-gate scan surface** — P1.1 review
- `apps/cli` and `apps/web` minimum file surface: `package.json` (`name` `@deepseek-ai/dsh-*`, `"type": "module"`, `publishConfig.access: public`, `repository.directory`, `files`, `dependencies`/`devDependencies`), `tsconfig.json` (extends `../../tsconfig.base.json`, `rootDir`/`outDir: lib/types`, `references` to workspace dependencies), `src/`, `tests/`, `README.md`. No package-level `.gitignore` (`lib/` and `apps/web/dist/` are covered by the root `.gitignore`).
- **`verify-application-entrypoints`** (`scripts/verify-application-entrypoints.ts`) scans `apps/*/package.json` `bin`: only `apps/cli` and webworker-packer's classified bins are allowed; `apps/desktop` **must not declare `bin`**. It also scans `apps/**/*.{ts,js,mjs,cjs}` `#!` shebangs (excluding `node_modules`/`lib`/`dist`) — `src/main.ts` must not start with `#!`.
- **`verify-package-dependencies`**: each new package needs the `@deepseek-ai/cordis` peer+dev dependency (if it participates in cordis). The Electron shell does not load cordis plugins; it is only a standalone host, so `apps/desktop` may skip declaring cordis but must pass `hygiene`'s dependency checks (`verify-package-dependencies` and `verify-dsh-package-licenses`).
- **`typecheck`**: the new `apps/desktop` must be referenced by some tsconfig project or compiled standalone; `apps/web` and `apps/cli` are not under the same solution root (each has its own `tsconfig.json`); `apps/desktop` uses a standalone `tsconfig.json` the same way.
- **`doc-sync`/`website`**: `docs/plans/` registers no leaf and enters no website projection (declared in §1); new `apps/desktop/README*` files must be handled per `verify-package-readme-model-experience` and `verify-package-readme-limitations` (a package README belongs to the package-README tier and needs a Model Experience section and Known Limitations).
- **`clean`** (`pnpm run clean`): cleans build artifacts and residue of deleted packages; must cover `apps/desktop`'s `lib/`, `.runtime/`, `release/` (handled in P1.8).
- **`duplication`** (cross-file TS clone detection): `src/main.ts`'s spawn/readiness-parsing/cleanup logic must avoid cloning other in-repo subprocess orchestration; P1.8 proves or rules out hits.

## 4. Target architecture

```
│  main.js (compiled from apps/desktop/src/main.ts)                     │
│  · resolveBackendLaunch(): dev apps/desktop/.runtime/; packaged        │
│    process.resourcesPath/dsh-runtime/                                  │
│  · env: { ...process.env, DSH_HOME: <userData>/dsh-home } (P5 onward)  │
│  · spawn(<node>, [<bin.js>, '--profile', 'web',                       │
│      '--no-open', '--port', '0'])    ← F3 flags + F1 ready parsing    │
│  · scan stdout for `dsh web: <url>` → loadURL(url)                    │
│    → 303+Set-Cookie → clean home (F2)                                  │
│  · will-navigate / setWindowOpenHandler: off-domain → shell.openExternal│
│  · before-quit / crash: kill backend process tree (taskkill /T)       │
│    → no orphans                                                        │
│  · logs: userData/logs/main.log + backend.log                          │
└───────────────┬───────────────────────────────────────────────────────┘
                │ spawn (same electron.exe with ELECTRON_RUN_AS_NODE=1,
                │   or a standalone node.exe — see decision D3)
┌───────────────▼───────────────────────────────────────────────────────┐
│  dsh backend assembly (pnpm deploy offline assembly, unpacked at       │
│  resources/dsh-runtime, not in asar)                                   │
│  lib/bin.js + node_modules + @deepseek-ai/dsh-web-frontend/dist        │
│  → serves / and /api, the event stream, static UI (F6)                 │
└────────────────────────────────────────────────────────────────────────┘
```

## 5. Decision table

| # | Decision | Options and recommendation | Basis |
|---|---|---|---|
| D1 | Shell project location | repo `apps/desktop`, package `@deepseek-ai/dsh-desktop` (`pnpm-workspace.yaml` already globs `apps/*`) | alongside apps/cli and apps/web in the app layer; the shell is not a plugin |
| D2 | Backend Node runtime | **ruled: packaged standalone node.exe** (the `ELECTRON_RUN_AS_NODE` first choice does not hold, proven by the P1.4 probe) | P1.4 probe: system Node ABI 137 passes; under Electron's built-in Node ABI 149 `fs-ext` gives `ERR_DLOPEN_FAILED` (see F10) |
| D3 | Backend start command | `spawn(<node>, [<bin.js>, '--profile', 'web', '--no-open', '--port', '0'])` | F1/F3/F7; `--port 0` is OS-assigned and the ready line gives the actual port, naturally conflict-free |
| D4 | User data | `DSH_HOME = app.getPath('userData')/dsh-home`, injected via shell env | F4; isolates user patches / sessions / credentials |
| D5 | Login exchange | `loadURL(authenticatedUrl)` once | F2/F5 |
| D6 | Port | default `--port 0` (OS-assigned); keep a shell-level `--port <n>` override for debugging | conflict-free; the cookie is bound to the authority, so each start on a new port resends the cookie — automatic via the exchange, so the user does not notice |
| D7 | Exit cleanup | `before-quit` kills the process tree (Windows `taskkill /pid <pid> /T /F` fallback), single-instance lock `requestSingleInstanceLock` | prevent orphans, prevent multiple instances |
| D8 | Packaging target | electron-builder `win.target: portable`; `asar: true` for the shell main only; `extraResources` installs dsh-runtime (unpacked, must not enter asar) | the backend needs `require.resolve` and native modules; it needs a real filesystem |

## 6. Task breakdown

Common convention: working directory `E:\ai\deepseek-harness`; each task ends with a `git commit` (message carries P#) and updates this file's §8 status table.

### P1.1 Contract-review wrap-up (read-only)
- Write path: this file only (§3 fact-table backfill) + no other writes.
- Review checklist:
  1. F4 `DSH_HOME` bootstrap-only list exact line numbers (`packages/boot/app-boot/src/index.ts:100-130`), confirm the conclusion that the shell must inject env.
  2. F7 gives one **executable probe command** for each of source-state vs assembled-state startup (source: `node --import tsx/esm apps/cli/src/bin.ts ...`; assembled: `node <deploy>/node_modules/@deepseek-ai/dsh/lib/bin.js ...`).
  3. F10: confirm whether `fs-ext` / `koffi` are N-API (cross-check `node -e "console.log(process.versions.modules)"`), decide whether the D2 first choice holds; list **all** native modules inside the web-profile closure (`pnpm why` / scan `.node` files after deploy).
  4. `apps/cli` and `apps/web`'s "app-layer minimum file surface" (package.json fields, tsconfig inheritance, README form, private/publish marks), for P1.2/P1.8.
  5. Root gates' scan surface for `apps/` and `docs/plans/` (`scripts/run-gates.ts`: typecheck / lint / hygiene / duplication / doc-sync / website / clean), list which failures new directories trigger.
- Acceptance: §3 fact table fully filled with line numbers; unresolved items marked "leave to live measurement" + a probe command; `git commit`.

### P1.2 apps/desktop engineering skeleton
- Write path: `apps/desktop/` (package.json, tsconfig.json, .gitignore, an empty-window src/main.ts, a placeholder src/preload.ts, README skeleton).
- Points:
  - Package `@deepseek-ai/dsh-desktop`; `"main": "lib/main.js"`, `"type": "module"`, tsc NodeNext compiles `src/` → `lib/`.
  - devDependencies: `electron` (version per the Electron/Node matching range reviewed in P1.1).
  - scripts: `build` (tsc), `start` (`electron .`).
  - Window security baseline in the skeleton: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, **disable** `webSecurity: false`; introduce no preload bridging (note: the UI is a trusted loopback page, the shell only orchestrates; Plan 2 designs the bridge separately).
  - `.gitignore`: `lib/`, `.runtime/`, `release/`, `*.log`.
- Acceptance: `pnpm install` succeeds; `pnpm --filter @deepseek-ai/dsh-desktop build` produces `lib/main.js`; `start` opens an empty window (on a displayless environment record the phenomenon + `electron --version` equivalent evidence).
- Risk: electron binary download fails → retry with mirror variables (`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`).

### P1.3 Main process v1 (dev pulls the source-state backend)
- Write path: `apps/desktop/src/main.ts` (+ necessary small modules).
- Points:
  - Backend start: per the P1.1 conclusion, use the source-state command + `--profile web --no-open --port 0` (F1/F3/F7).
  - stdout parsing: scan per the F1 regex (not the first line); no ready line within a 60s timeout → error dialog + log, not silent.
  - Port: default `--port 0`; shell-level `--port <n>` override.
  - Window: load the resolved URL; `will-navigate` / `setWindowOpenHandler` constraints (off-domain → `shell.openExternal`, loopback allowed through).
  - Exit cleanup: kill the backend process tree on `before-quit` / `window-all-closed` / main-process crash (D7).
  - Reserve a `resolveBackendLaunch()` seam; P1.5 switches to the assembled state.
- Acceptance: `start` brings up the backend (log shows a `dsh web:` line) → the window shows the dsh GUI home (complete the 401→cookie exchange; cross-check with curl: no-token `GET /` gives 401, the in-shell page works) → no residual backend process after closing; a busy-port error alert is visible.
- Risk: the source-state startup chain differs from F7 → correct the command from the actual log and backfill this file.

### P1.4 Backend assembly runtime
- Write path: `apps/desktop/scripts/assemble.mjs`, `apps/desktop/.runtime/` (gitignored, not committed).
- Points:
  - Pre-builds (P1.1 gives the minimal set): each workspace package's `lib/` + `apps/web` dist (`@deepseek-ai/dsh-web-frontend`'s dist, F6); the script first does an existence check, and a missing build reports "please build first".
  - Assembly: `pnpm --filter @deepseek-ai/dsh deploy <apps/desktop/.runtime>` (clear first, idempotent); print an output summary (bin path, node_modules layout, whether the UI dist is in place, total size).
  - **ABI probe (the D2 ruling point)**: in a clean child process (detached from the repo cwd) run the assembled bin with the target node, confirm (a) it starts and prints a `dsh web:` line; (b) native modules (fs-ext / koffi / node-addon-require-builtin, F10) load with no `ERR_DLOPEN`. On failure → fall back to the D2 alternative (standalone node.exe), record the conclusion and backfill this file.
  - Environment: if the assembly network access fails → `--offline` (the store is already present from the repo install).
- Acceptance: the script runs repeatably; directory structure/size recorded; the standalone verification prints `dsh web:` and `curl -sI` returns 401 (alive) then terminates cleanly; `.runtime/` is gitignored.
- Risk and fallback: pnpm deploy behaves unexpectedly for private/vendor workspace packages → alternative: per-package `pnpm pack` staging + `npm install --offline`; if it still fails → blocked with the phenomenon appended.

### P1.5 Main process v2 (assembled state + DSH_HOME injection)
- Write path: `apps/desktop/src/main.ts` rework.
- Points:
  - `resolveBackendLaunch()`: dev → `apps/desktop/.runtime/`; packaged → `process.resourcesPath/dsh-runtime/` (the P1.6 on-disk path).
  - Start: `spawn(<node>, [<bin.js>, '--profile', 'web', '--no-open', '--port', '0'], { env: { ...process.env, DSH_HOME: <userData>/dsh-home }, windowsHide: true })` (D2/D3/D4).
  - No-env-key path verification (pure UI self-service config, see Plan 2 §4 fact): injects no `DEEPSEEK_*`; the UI settings page can add a key and it persists to `DSH_HOME`.
  - Port/error/exit cleanup carry over from P1.3.
- Acceptance: under dev, start goes through the assembled state and the ready line comes from the `.runtime/` backend; the window completes the exchange into the home; `<userData>/dsh-home` is created and UI config persists; no residue on close.
- Risk: `ELECTRON_RUN_AS_NODE` behaves unusually → the D2 alternative standalone node.exe (note the cost: size +~50MB).

### P1.6 electron-builder packages the portable exe
- Write path: `apps/desktop/electron-builder.yml`, `release/` (gitignored), `scripts/` (icon/asset prep).
- Points:
  - Add `electron-builder` to devDependencies; add the `dist` script.
  - Config: `appId`, `productName`, `directories.output: release`, `files` (shell lib + package.json + assets, not .runtime), `extraResources` (`.runtime/` → `resources/dsh-runtime`; must be unpacked, cannot enter asar), `win.target: portable`, `asar: true`, `npmRebuild: false`, `electronLanguages`/`compression` by size.
  - Icon: no asset yet, do not configure (default icon + warning); P1.8 records "official release needs .ico".
  - Download fallback: on binary download failure retry with the P1.2 mirror variables.
- Acceptance: `release/` produces `*portable.exe`; record the filename and size; no fatal errors.
- Risk: the portable target's nsis download fails → fall back to `win.target: dir` to verify the chain, then state it honestly.

### P1.7 Artifact cold-start verification
- Write path: `docs/plans/notes/verification-shell.md` (new).
- Recipient-perspective checklist (evidence per item):
  1. Cold start: run the exe from a non-repo directory with node/pnpm temporarily removed from the PATH → the window appears and completes the exchange into the home.
  2. Lifecycle: `tasklist` observes no residual electron/backend processes after closing.
  3. User data: `%APPDATA%/<ProductName>/dsh-home` shows the expected files (sessions / settings).
  4. Keyless path: with no env configured, the UI settings page can add a key and persist it.
  5. Reuse: restart the exe; sessions/settings remain.
  6. Port in use: pre-occupy 3080 → explicit error alert (under `--port 0` this should not occur; instead verify the shell-level `--port 3080` override path).
  7. Size/antivirus: record the size and any warnings.
- Acceptance: verification-shell.md gives a command/evidence or "unverified + reason" for each item.

### P1.8 Wrap-up: documentation and repo compliance
- Write path: `apps/desktop/README*`, this file's status table, gate allowlist/registration (if needed).
- Points:
  - README (usage: assemble → start/dist, artifact description, config, limitations: lifecycle tied to the shell, data directory, unsigned, missing icon, size).
  - Gate handling: whether `clean` clears apps/desktop artifacts and syncs; `typecheck`/`lint` pass locally; `duplication` excludes or proves no hits; `doc-sync`/`website` handling for `docs/plans/` and the new README (exclude/register, pick the minimal compliance path per the P1.1 conclusion); `hygiene` checks package.json.
  - Locally run only the minimal affected gate subset, record each.
  - Final diff self-check: `git status` leaves only the expected files; no `.runtime/`, `release/`, node_modules leak into the repo.
- Acceptance: apps/desktop is structurally complete; the listed gates pass or have a written exemption; delivery summary (Chinese).

## 7. Non-goals

- No "task state → reminder" logic (Plan 2).
- No auto-update, code signing, or official icon (recorded as known limitations).
- No LAN serving (`--host 0.0.0.0` rejected, F3).
- No built-in terminal/PTY, e2b, or LSP (not in the web-profile closure, F9).
- No shell-level multilingual UI (product copy belongs to the Web UI's locale system).

## 8. Status table

| Task | Status | Date | Notes |
|---|---|---|---|
| P1.1 Contract-review wrap-up | done | 2026-09-06 | see §3 review record |
| P1.2 Engineering skeleton | done | 2026-09-06 | see §8 notes; Electron 44.2.0 installed via npmmirror |
| P1.3 Main process v1 | done | 2026-09-06 | dev source-state backend; readiness parsing/login exchange/exit cleanup measured |
| P1.4 Backend assembly | done | 2026-09-07 | `deploy-root` closure manifest (228 workspace packages) + `scripts/assemble.mjs` (deploy→restoreLegacyHoists→materializeStagedLinks→summary→ABI probe); `.runtime/` 212.1 MB; D2 ruled by the probe (see F10) |
| P1.5 Main process v2 | done | 2026-09-07 | `resolveBackendLaunch()` switches to the assembled state (dev `.runtime/`, packaged `resources/dsh-runtime` + `resources/node/node.exe`); `DSH_HOME = userData/dsh-home` env injection; dev measured: ready line from the `.runtime` backend, `dsh-home` created, no residue on close |
| P1.6 Packaging | done | 2026-09-07 | `electron-builder.yml` + `assemble` extension (`.runtime-pack/` nested payload, `.runtime-node/` node.exe staging, probe home moved out of the payload); `portable.useZip: true` single-step embedding avoids the extraction race; artifact `DeepSeek Harness Desktop 0.1.3-alpha.1.exe` 220.6 MB; dependency/race/readiness fixes see [verification-shell.md §8](notes/verification-shell.md) |
| P1.7 Cold-start verification | done | 2026-09-07 | see [notes/verification-shell.md](notes/verification-shell.md); cold start/lifecycle/user data/keyless path/reuse/port-in-use/size evidenced item by item |
| P1.8 Wrap-up | done | 2026-09-07 | README completed (Model Experience + Known Limitations); `constraints` registers `appPackageFiles` and adds release metadata; desktop oxlint clean; README/dedup/md-links/constraints pass; hygiene leaves 2 pre-existing failures (built invariants, cordis-config, reproducible on a clean tree, unrelated to this branch) |

### Handoff record (2026-09-07 · continue on another machine)

- **Committed**: P1.1–P1.5 all in; this branch is `dev`. Next machine: `git pull` → `pnpm install` → `pnpm run build` + `pnpm run build:web` → `pnpm --filter @deepseek-ai/dsh-desktop assemble` → `pnpm --filter @deepseek-ai/dsh-desktop start` (`.runtime/` and `release/` are machine-local artifacts, not committed; re-assemble).
- **Environment facts (this machine)**: Node v24.0.0 ABI 137; Electron 44.2.0's built-in Node v24.20.0 ABI 149 (so D2 falls back to a standalone node.exe); pnpm v11.7.0 (`pnpm.cmd`; pwsh blocks scripts); when the electron binary download is unreachable use `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`, and the proxy 127.0.0.1:7897 when needed; the npm registry is directly reachable.
- **Notes**: `assemble.mjs`'s deploy target must be an absolute path (a relative-path legacy deploy generates a junk tree inside workspace packages — this session already cleaned the `vendor/schemastery/apps` residue; do not trigger it again); probe flags via pnpm forwarding look like `pnpm --filter @deepseek-ai/dsh-desktop run assemble -- --electron-probe`; under PowerShell `pnpm.cmd ... 2>&1` shows pnpm's stderr banner as NativeCommandError (a false positive; judge the exit code with `1> out 2> err; $LASTEXITCODE`).
- **Todo (later machine)**: this branch `dev` already carries all P1.1–P1.8 implementation and verification records. New-machine flow: `git pull` → `pnpm install` → `pnpm run build` + `pnpm run build:web` → `pnpm --filter @deepseek-ai/dsh-desktop assemble` → `start` (`.runtime*` and `release/` are machine-local artifacts, not committed; re-assemble); `dist` needs `ELECTRON_MIRROR` (npmmirror) and `ELECTRON_BUILDER_BINARIES_MIRROR`. Plan 2 (notifications/taskbar) can load on this plan's artifact.

## 9. Risk summary

| Risk | Impact | Mitigation |
|---|---|---|
| Native-module ABI incompatibility with Electron Node (F10) | backend fails to start | P1.4 probe rules D2 up front; fall back to standalone node.exe |
| pnpm deploy behaves unexpectedly for private/vendor workspace packages | assembly fails | P1.4 alternative pack+offline assembly |
| Binary downloads (electron/nsis) | build fails | retry with mirror variables |
| Size 150–400MB | distribution experience | P1.6 records, P1.8 explains |
| Unsigned antivirus false positives | distribution blocked | P1.8 explains + official release needs signing |
| Port conflict | start fails | `--port 0` (D3) + explicit error alert |
| Repo gates scan new directories | CI red | P1.1 maps out + P1.8 unified handling |
