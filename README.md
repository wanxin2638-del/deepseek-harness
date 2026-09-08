# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

### Run the Windows desktop app

First build and stage the desktop runtime using the [desktop setup guide](apps/desktop/README.md#windows-cold-start-from-a-fresh-state). With dependencies installed and the runtime staged, run these commands from the repository root in CMD or PowerShell:

```cmd
cd apps\desktop
npm start
```

`npm start` runs the Electron script using the installed dependencies. To use pnpm, run this command from `apps/desktop`:

```cmd
pnpm --config.verify-deps-before-run=false start
```

The pnpm option disables the dependency check for this launch. In pnpm 11.7.0, a production-mode workspace state can make the check run `install --production`, removing development dependencies such as Electron.

If those dependencies have been removed, restore them from the repository root before launching:

```cmd
pnpm install --prod=false --frozen-lockfile --config.confirmModulesPurge=false
node apps/desktop/node_modules/electron/install.js
```

The install command restores dependencies from the existing lockfile; the second command ensures the Electron executable is available. Run these recovery commands only when dependencies are missing.

## Build, launch, and package from a clean checkout

Use the following PowerShell commands from the repository root for a fresh Windows desktop setup. The root `build` command builds the Host, Client, and Web artifacts; `assemble` stages the backend closure and standalone Node runtime required by the desktop shell.

### Build and launch

```powershell
pnpm install --config.confirmModulesPurge=false
pnpm --filter @deepseek-ai/dsh-desktop build
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop assemble
pnpm --config.verify-deps-before-run=false --filter @deepseek-ai/dsh-desktop start
```

If `apps\desktop\node_modules\electron\dist\electron.exe` is missing after installation, run this once from `apps\desktop` and then return to the repository root:

```powershell
node node_modules\electron\install.js
```

### Build the portable executable

Run the build and staging steps first, then package the portable executable:

```powershell
pnpm install --config.confirmModulesPurge=false
pnpm --filter @deepseek-ai/dsh-desktop build
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop assemble
$env:CI='true'
$env:npm_config_ignore_scripts='true'
pnpm --filter @deepseek-ai/dsh-desktop dist
```

The `CI` and `npm_config_ignore_scripts` variables keep Electron Builder's internal production dependency install non-interactive and prevent the root development postinstall hook from running after production pruning. The packaged executable is written to `apps\desktop\release\`. The `.runtime\`, `.runtime-node\`, `.runtime-pack\`, and `release\` directories are local build products and must be regenerated on a fresh checkout.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
