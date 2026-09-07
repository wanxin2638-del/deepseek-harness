# @deepseek-ai/dsh-desktop

English | [中文](README.zh.md)

Windows portable Electron shell hosting the official DeepSeek Harness Web backend (`dsh --profile web`). The shell is a host, not a plugin: it spawns the backend, resolves its ready URL, completes the login exchange, constrains navigation, and cleans up the child process tree on exit. It carries no product logic.

## Usage

Prerequisites: a built backend and staged runtime. Run from the workspace root:

```sh
pnpm run build && pnpm run build:web
pnpm --filter @deepseek-ai/dsh-desktop assemble   # stage .runtime, .runtime-node, .runtime-pack
pnpm --filter @deepseek-ai/dsh-desktop start      # launch the shell in dev (uses .runtime)
pnpm --filter @deepseek-ai/dsh-desktop dist       # build the portable exe into release/
```

## Windows: cold start from a fresh state

The steps above run on a POSIX shell from the workspace root. On Windows PowerShell the
`&&` separator and the `--filter ... start` deps-status check both get in the way: PowerShell
rejects `&&` (use `;` or separate lines), and `pnpm --filter @deepseek-ai/dsh-desktop start`
first runs `pnpm install --production`, whose root postinstall fails when dev dependencies are
missing (Electron and lefthook are dev deps). Run the worksheet below instead:

```powershell
# 1. Re-link all workspace dependencies (dev + prod), purging any stale tree.
pnpm install --config.confirmModulesPurge=false

# 2. If Electron's binary was never downloaded, fetch it through your proxy.
cd apps\desktop
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:HTTP_PROXY='http://127.0.0.1:7897'
node node_modules\electron\install.js

# 3. Build and stage the runtime.
cd ..\..
pnpm run build
pnpm run build:web
pnpm --filter @deepseek-ai/dsh-desktop assemble

# 4. Launch directly from the package (avoids the --filter deps-status check).
cd apps\desktop
pnpm start
```

Step 2 is only needed on a machine where `apps\desktop\node_modules\electron\dist\electron.exe`
does not exist; the proxy address is your local HTTP proxy, not a hard requirement.

The portable exe is fully self-contained: it embeds the Electron runtime, the assembled backend closure (`resources/dsh-runtime`), and a standalone Node runtime (`resources/node/node.exe`), so the recipient machine needs no Node, pnpm, Python, or git. Backend and shell state live under `%APPDATA%\DeepSeek Harness Desktop\dsh-home` (the shell injects `DSH_HOME`; `.env` cannot set it).

`assemble` also runs the ABI probe (D2): it launches the staged backend under the machine's Node, expects the ready line plus `GET / → 401`, and stages the probed `node.exe` as `.runtime-node/node.exe` for the packaged payload.

## Model Experience

Users run one executable and get the full Web GUI. There is no environment setup, no browser to start, and no terminal; port allocation is automatic (`--port 0`). Closing the window stops the backend process tree. A `--port <n>` argument overrides the port for debugging; if the port is taken, an error dialog explains the failure.

## Configuration

- `--port <n>` — override the OS-assigned port. Debugging only; a busy port fails loud with a dialog.
- No `DEEPSEEK_*` values are injected: configure the API key from the Web UI settings page, which persists it into `$DSH_HOME`.

## Known Limitations

- The packaged runtime closure and standalone Node are staged per machine by `assemble`; `.runtime/`, `.runtime-node/`, `.runtime-pack/`, and `release/` are gitignored build products, so a fresh clone must run `assemble` again.
- No code signing, auto-update, or production icon; the executable is unsigned and uses the default Electron icon.
- The portable exe is ~220 MB (electron runtime + backend closure + standalone Node); packaging uses `portable.useZip: true` for single-step extraction, trading size for reliable cold start on machines where antivirus scanning of large payload files can race a staged copy.
- No LAN serving (`--host 0.0.0.0` is rejected by the web profile).
- No terminal/PTY, E2B, or LSP support in the packaged web profile (out of its dependency closure by design).

Working plan: [docs/plans/desktop-shell.md](../../docs/plans/desktop-shell.md). Cold-start verification record: [docs/plans/notes/verification-shell.md](../../docs/plans/notes/verification-shell.md).