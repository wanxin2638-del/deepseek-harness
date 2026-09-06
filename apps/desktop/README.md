# @deepseek-ai/dsh-desktop

Windows portable Electron shell hosting the official DeepSeek Harness Web backend (`dsh --profile web`). The shell is a host, not a plugin: it spawns the backend, resolves its ready URL, completes the login exchange, constrains navigation, and cleans up the child process tree on exit. It carries no product logic.

## Status

Working plan: [docs/plans/desktop-shell.md](../../docs/plans/desktop-shell.md). This package is under construction.

## Usage

Prerequisites: a built backend. Run `pnpm --filter @deepseek-ai/dsh-desktop assemble` to stage the backend runtime into `.runtime/`, then `pnpm --filter @deepseek-ai/dsh-desktop start` to launch the shell in dev. `pnpm --filter @deepseek-ai/dsh-desktop dist` builds the portable exe into `release/`.

## Known Limitations and Deferred Work

- Under construction; the shell currently opens a blank window and does not yet host the backend.
- No code signing, auto-update, or production icon (tracked by the working plan).
