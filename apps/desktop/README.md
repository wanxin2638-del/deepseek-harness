# @deepseek-ai/dsh-desktop

Windows portable Electron shell hosting the official DeepSeek Harness Web backend (`dsh --profile web`). The shell is a host, not a plugin: it spawns the backend, resolves its ready URL, completes the login exchange, constrains navigation, and cleans up the child process tree on exit. It carries no product logic.

## Status

Working plan: [docs/plans/desktop-shell.md](../../docs/plans/desktop-shell.md). This package is under construction; the shell hosts the source backend in dev and the assembled backend once `assemble` has staged it.

## Usage

Prerequisites: a built backend. Run `pnpm --filter @deepseek-ai/dsh-desktop assemble` to stage the backend runtime into `.runtime/`, then `pnpm --filter @deepseek-ai/dsh-desktop start` to launch the shell in dev. `pnpm --filter @deepseek-ai/dsh-desktop dist` builds the portable exe into `release/`.

## Known Limitations and Deferred Work

- The shell is a development host; the assembled backend runtime (`assemble`) is in place, but packaging (`dist`) and cold-start verification are still pending.
- No code signing, auto-update, or production icon (tracked by the working plan).
