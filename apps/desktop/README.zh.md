# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

承载官方 DeepSeek Harness Web 后端（`dsh --profile web`）的 Windows 便携式 Electron 壳。壳是宿主而非插件：它拉起后端、解析就绪 URL、完成登录交换、约束导航，并在退出时清理子进程树。它不携带任何产品逻辑。

## 用法

前置：已构建后端与已暂存的运行时。在仓库根目录运行：

```sh
pnpm run build && pnpm run build:web
pnpm --filter @deepseek-ai/dsh-desktop assemble   # 暂存 .runtime、.runtime-node、.runtime-pack
pnpm --filter @deepseek-ai/dsh-desktop start      # 以 .runtime 启动壳（开发）
pnpm --filter @deepseek-ai/dsh-desktop dist       # 构建 release/ 中的便携 exe
```

便携 exe 完全自包含：它内嵌 Electron 运行时、装配后的后端闭包（`resources/dsh-runtime`）与独立 Node 运行时（`resources/node/node.exe`），因此收件机无需 Node、pnpm、Python 或 git。后端与壳状态存放于 `%APPDATA%\DeepSeek Harness Desktop\dsh-home`（壳注入 `DSH_HOME`；`.env` 无法设置它）。

`assemble` 还会运行 ABI 探针（D2）：它在机器 Node 下启动暂存后端，期望就绪行加 `GET / → 401`，并把探针得到的 `node.exe` 暂存为 `.runtime-node/node.exe` 作为打包载荷。

## 模型体验

用户运行一个可执行文件即得到完整 Web GUI。无需环境配置、无需启动浏览器、无需终端；端口自动分配（`--port 0`）。关闭窗口即停止后端进程树。`--port <n>` 参数可为调试覆盖端口；端口被占用时错误对话框说明失败。

## 配置

- `--port <n>` — 覆盖操作系统分配端口。仅供调试；端口繁忙将以对话框明确失败。
- 不注入任何 `DEEPSEEK_*` 值：在 Web UI 设置页配置 API key，它会持久化到 `$DSH_HOME`。

## 已知限制

- 打包的运行时闭包与独立 Node 由 `assemble` 按机暂存；`.runtime/`、`.runtime-node/`、`.runtime-pack/`、`release/` 都是 gitignored 构建产物，因此新克隆需再次运行 `assemble`。
- 无代码签名、自动更新或正式图标；可执行文件未签名并使用默认 Electron 图标。
- 便携 exe 约 220 MB（Electron 运行时 + 后端闭包 + 独立 Node）；打包用 `portable.useZip: true` 做单步解包，以体积换取在大文件杀软扫描可能竞态暂存副本的机器上的可靠冷启动。
- 不支持 LAN 服务（web profile 拒绝 `--host 0.0.0.0`）。
- 打包的 web profile 不支持终端/PTY、E2B 或 LSP（按其设计不在依赖闭包内）。

工作计划：[docs/plans/desktop-shell.zh.md](../../docs/plans/desktop-shell.zh.md)。冷启动验证记录：[docs/plans/notes/verification-shell.zh.md](../../docs/plans/notes/verification-shell.zh.md)。
