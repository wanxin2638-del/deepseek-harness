# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

承载官方 DeepSeek Harness Web 后端（`dsh --profile web`）的 Windows Electron 桌面壳。壳是宿主而非插件：它拉起后端、解析就绪 URL、完成登录交换、约束导航，并在退出时清理子进程树。它不携带任何产品逻辑。

## 用法

前置：已构建后端与已暂存的运行时。在仓库根目录运行：

```sh
pnpm run build && pnpm run build:web
pnpm --filter @deepseek-ai/dsh-desktop assemble   # stage .runtime, .runtime-node, .runtime-pack
pnpm --config.verify-deps-before-run=false --filter @deepseek-ai/dsh-desktop start  # launch using .runtime
pnpm --filter @deepseek-ai/dsh-desktop dist       # build the Windows installer into release/
```

<a id="windows-cold-start-from-a-fresh-state"></a>

## Windows：从全新状态冷启动

上面的步骤从仓库根在 POSIX shell 下运行。下面的步骤使用 Windows PowerShell 语法，各条命令分行执行。日常启动与依赖恢复方法见[根目录 README](../../README.zh.md#run-the-windows-desktop-app)。

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

# 4. Launch the installed Electron app.
cd apps\desktop
npm start

```

第 2 步仅在 `apps\desktop\node_modules\electron\dist\electron.exe` 不存在的机器上需要；代理地址是你的本地 HTTP 代理，不是硬性要求。

便携 exe 完全自包含：它内嵌 Electron 运行时、装配后的后端闭包（`resources/dsh-runtime`）与独立 Node 运行时（`resources/node/node.exe`），因此收件机无需 Node、pnpm、Python 或 git。后端与壳状态存放于 `%APPDATA%\DeepSeek Harness Desktop\dsh-home`（壳注入 `DSH_HOME`；`.env` 无法设置它）。

`assemble` 还会运行 ABI 探针（D2）：它在机器 Node 下启动暂存后端，期望就绪行加 `GET / → 401`，并把探针得到的 `node.exe` 暂存为 `.runtime-node/node.exe` 作为打包载荷。

## 模型体验

用户运行安装后的应用即可得到完整 Web GUI。无需环境配置、无需启动浏览器、无需终端；端口自动分配（`--port 0`）。关闭窗口时，应用会询问是退出，还是继续运行在 Windows 系统托盘中；托盘菜单可以恢复窗口或退出应用。`--port <n>` 参数可为调试覆盖端口；端口被占用时错误对话框说明失败。

## 配置

- `--port <n>` — 覆盖操作系统分配端口。仅供调试；端口繁忙将以对话框明确失败。
- 不注入任何 `DEEPSEEK_*` 值：在 Web UI 设置页配置 API key，它会持久化到 `$DSH_HOME`。

## 已知限制

- 打包的运行时闭包与独立 Node 由 `assemble` 按机暂存；`.runtime/`、`.runtime-node/`、`.runtime-pack/`、`release/` 都是 gitignored 构建产物，因此新克隆需再次运行 `assemble`。
- 不包含自动更新；代码签名取决于构建环境。
- Windows 安装包是自包含的，包含 Electron 运行时、后端闭包和独立 Node，因此体积较大。
- 不支持 LAN 服务（web profile 拒绝 `--host 0.0.0.0`）。
- 打包的 web profile 不支持终端/PTY、E2B 或 LSP（按其设计不在依赖闭包内）。

工作计划：[docs/plans/desktop-shell.zh.md](../../docs/plans/desktop-shell.zh.md)。冷启动验证记录：[docs/plans/notes/verification-shell.zh.md](../../docs/plans/notes/verification-shell.zh.md)。
