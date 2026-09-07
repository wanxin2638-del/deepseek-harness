# Desktop Shell Artifact Cold-Start Verification Record (P1.7)

English | [中文](verification-shell.zh.md)

> Working plan document, not part of the `docs/` release tree: not registered as a doc-sync leaf, not projected into the website.

> Verification target: `apps/desktop/release/DeepSeek Harness Desktop 0.1.3-alpha.1.exe` (electron-builder portable, `portable.useZip: true`, `resources/dsh-runtime` 213.5 MB + `resources/node/node.exe` 81.3 MB, exe 220.6 MB).

> Machine: Windows 11 (build 26200) x64, no attached display (RDP/headless desktop); measured paths and phenomena recorded as observed.

## 1. Cold start (recipient perspective)

**Evidence**: `ProcessStartInfo` launches the exe with `WorkingDirectory=C:\` and `UseShellExecute=false`; the shell keeps only the `C:\Windows\System32;C:\Windows` PATH (no node/pnpm), simulating a recipient machine.

- Within ~40s `DeepSeek Harness Desktop.exe` appears (main process) plus 3 `--type=*` child processes plus 1 `resources\node\node.exe` (backend).
- `%APPDATA%\DeepSeek Harness Desktop\logs\main.log`:
  ```
  [main] desktop shell starting, repo root C:\Users\ADMINI~1\AppData\Local\Temp\3Iyut8Bz8KxDKQqpgvbY5zJLGkl
  [main] electron 44.2.0, node 24.20.0
  [main] backend ready: http://127.0.0.1:58220/?token=kKzR293jPJOyNTsNvV5XWP2y7Ft6xY4VQbjgxdaZoJA
  ```
- Login exchange (curl cross-check, F2 contract):
  - no token `GET /` → `401`
  - token `GET /?token=...` (follow 303) → `200`, `Set-Cookie: dsh-auth-<sha256(authority)>` (HttpOnly, 30 days)
  - with the cookie `GET /` → `200`, returns `<!doctype html>` (`@deepseek-ai/dsh-web-frontend/dist/index.html`)
- Conclusion: **pass**. Cold start has no environment requirement; the token→cookie exchange into the home page is automatic.

## 2. Lifecycle: no residue after closing the window

**Evidence**: send `taskkill /PID <main>` to the main process (equivalent to a graceful WM_CLOSE close), and after 15s `Get-CimInstance Win32_Process` filtered by `DeepSeek*` and the `resources\node\node.exe` command line → **0 processes**. The `before-quit` → `dispose()` → `taskkill /T /F` process-tree cleanup takes effect, and the backend node.exe leaves no orphans.

**Note**: posting `WM_CLOSE` directly to the top window did not trigger a close on the headless desktop (the window rect reads 0,0 / negative coordinates, a headless-desktop position quirk); `taskkill` (system-level WM_CLOSE) reliably triggers the full close chain, so it is used as the "close window" equivalent for evidence.

## 3. User data directory

**Evidence**: `%APPDATA%\DeepSeek Harness Desktop\dsh-home` is created:
- `profiles/` (web profile assembly) and `profiles/node_modules/`
- `storages/workspace.json`, `settings.yaml`, `.credentials.yaml` (credential record), `.anonymous-user-id`

When `productName: "DeepSeek Harness Desktop"` is absent, Electron falls back to the package.json `name` (`@deepseek-ai\dsh-desktop`), producing the wrong data directory; `productName` was added to package.json and rebuilt (all data in this record sits at the correct path).

## 4. Keyless path (pure UI self-service configuration)

**Evidence**:
- The backend child process is started by `resources\node\node.exe <bin.js> --profile web --no-open --port 0` (visible in the backlog); the shell env injects only `DSH_HOME`, no `DEEPSEEK_*`.
- The UI renders and persists for real inside the shell: `settings.yaml` shows `ui-onboarding.welcomeNoticeVersion: 2026-08-13.1` (written by the Web UI into `$DSH_HOME`).
- `.credentials.yaml` is created (`version: 1 / records:` structure), so the settings page can write a key and it lands in `$DSH_HOME`.
- Conclusion: **pass (UI rendering + persistence chain)**; the per-key "type a key on the settings page" is not manually verified because on a headless desktop with a model that takes no image input the page cannot be seen/clicked; the chain is covered equivalently by the onboarding-version persistence.

## 5. Reuse: sessions/settings survive a restart

**Evidence** (same `%APPDATA%`, two launches):
- After the first launch `settings.yaml` contains `welcomeNoticeVersion`, `storages/workspace.json` (199 B).
- After closing and relaunching → a new ready URL (`127.0.0.1:65221`) → `settings.yaml` unchanged and `workspace.json` still present.
- Conclusion: **pass**. The data directory is reused, not recreated/emptied.

## 6. Port in use / shell-level --port override

**Scenario**: on the working machine `127.0.0.1:3080` is already in use (DSH Web GUI listening), the exe is launched with `--port 3080`.

**Evidence**:
- `main.log`: `[main] backend readiness failed: backend exited with code 1 before readiness:`, tail includes `EADDRINUSE ... port: 3080` (the backend stderr is folded into the error text; before this fix it was missing, see §record).
- The main process stays alive and shows a native error dialog (window class `#32770`, title `Error`) until the user confirms; after confirm `app.exit(1)` cleans up and exits with no residue.
- The default `--port 0` is OS-assigned, so no conflict is possible (D3); the shell-level `--port` override is debugging-only and **fails loud** on a conflict.
- Conclusion: **pass** (`--port 3080` override + explicit error dialog on a busy-port conflict).

## 7. Size / antivirus

- exe size 220.6 MB (electron runtime + backend assembly + standalone node.exe). Unpacked `resources\dsh-runtime` 213.5 MB, `resources\node\node.exe` 81.3 MB.
- No code signing; antivirus (Windows Defender Real-time) scanning the 85 MB node.exe on first pass can occasionally drop a file during the portable extraction: the first two-stage version (Nsis7z extract + CopyFiles) was observed losing `resources\node\node.exe` on a cold extract (the shell reported `spawn ... ENOENT`); switched to direct `File /r` inline single-step extraction via `portable.useZip: true`, and repeated cold starts no longer reproduce it (§record).
- Antivirus popups/blocking: neither SmartScreen nor Defender blocked on this machine; the unsigned warning cannot be seen in a headless environment, so it is recorded as "unverified + reason".

## 8. Record (troubleshooting and fixes)

- **P1.4 probe conclusion re-check**: this machine's system Node v22.19.0 (ABI 127) runs the assembled `lib/bin.js` probe and passes (ready line + 401, no ERR_DLOPEN), consistent with the D2 decision; in the packaged build this backend is carried by `resources\node\node.exe` (bundled standalone Node), and Electron's built-in Node (v24.20.0 ABI 149) is only the shell.
- **electron-builder dependency fix**: `app-builder-lib@26.15.3` reads `@electron/get`'s `ElectronDownloadCacheMode` (exported only in 3.1.0) while declaring `^3.0.0`; locking the old 3.0.0 gives `Cannot read properties of undefined (reading 'ReadWrite')`. Used a `pnpm-workspace.yaml` override `app-builder-lib@26.15.3>@electron/get: 3.1.0` (a broad update would refresh hundreds of unrelated lock entries, so a precise override is used).
- **Extraction race**: the portable default two-stage (Nsis7z extracts to `$PLUGINSDIR\7z-out` → CopyFiles to `$TEMP\<unpackDirName>`, extractAppPackage.nsh) occasionally drops `node.exe` on cold start (when the recipient machine's first-pass scan hits a newly written large file). `portable.useZip: true` goes through portable.nsi's `File /r` single-step inline embedding, avoiding the staged copy; the cost is that the exe grows from 130.8 MB to 220.6 MB (NSIS built-in zlib compression vs 7z LZMA).
- **Silent readiness-failure exit**: when the backend exits before printing the ready line (e.g. EADDRINUSE), the original shell implementation only called `app.quit()` and closed the window silently with no error, violating "fail loud". Fix: `src/backend.ts` rejects ready on the exit event when not settled/not disposed, appending the tail of the backend stdout+stderr to the error text; `src/main.ts`'s `onExit` closes the window only when an already-ready backend crashes. Verified: `--port 3080` conflict → log carries `EADDRINUSE ... port: 3080` + a native error dialog.
- **Unverified items**: official .ico (default Electron icon + warning); code signing / antivirus allowlisting.
