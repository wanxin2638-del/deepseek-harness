# 桌面壳产物冷启动验证记录（P1.7）

[English](verification-shell.md) | 中文

> 工作规划文档，不属于 `docs/` 发布树：不注册 doc-sync leaf、不进 website 投影。

> 验证对象：`apps/desktop/release/DeepSeek Harness Desktop 0.1.3-alpha.1.exe`（electron-builder portable，`portable.useZip: true`，`resources/dsh-runtime` 213.5 MB + `resources/node/node.exe` 81.3 MB，exe 220.6 MB）。

> 机器：Windows 11（build 26200）x64，无独立显示器（RDP/headless 桌面），实测路径与现象如实记录。

## 1. 冷启动（收件人视角）

**证据**：`ProcessStartInfo` 以 `WorkingDirectory=C:\`、`UseShellExecute=false` 启动 exe；shell 仅保留 `C:\Windows\System32;C:\Windows` 的 PATH（不含 node/pnpm），模拟收件机。

- ~40s 内出现 `DeepSeek Harness Desktop.exe`（主进程）+ 3 个 `--type=*` 子进程 + 1 个 `resources\node\node.exe`（后端）。
- `%APPDATA%\DeepSeek Harness Desktop\logs\main.log`：
  ```
  [main] desktop shell starting, repo root C:\Users\ADMINI~1\AppData\Local\Temp\3Iyut8Bz8KxDKQqpgvbY5zJLGkl
  [main] electron 44.2.0, node 24.20.0
  [main] backend ready: http://127.0.0.1:58220/?token=kKzR293jPJOyNTsNvV5XWP2y7Ft6xY4VQbjgxdaZoJA
  ```
- Login exchange（curl 对照，F2 契约）：
  - 无 token `GET /` → `401`
  - token `GET /?token=...`（follow 303）→ `200`，`Set-Cookie: dsh-auth-<sha256(authority)>`（HttpOnly，30 天）
  - 带 cookie `GET /` → `200`，返回 `<!doctype html>`（`@deepseek-ai/dsh-web-frontend/dist/index.html`）
- 结论：**通过**。冷启动无环境要求，自动完成 token→cookie 交换进首页。

## 2. 生命周期：关窗后无残留

**证据**：对主进程发 `taskkill /PID <main>`（等价 WM_CLOSE 优雅关窗），15s 后 `Get-CimInstance Win32_Process` 过滤 `DeepSeek*` 与 `resources\node\node.exe` 命令行 → **0 个进程**。`before-quit` → `dispose()` → `taskkill /T /F` 进程树清理生效，后端 node.exe 无孤儿。

**注意**：`WM_CLOSE` 直接 PostMessage 到顶窗在无显示器桌面上未触发关闭（窗口 rect 读到 0,0 / 负坐标，属 headless 桌面位置怪象）；`taskkill`（系统级 WM_CLOSE）稳定触发完整关闭链，故以它作为"关窗"等价操作取证。

## 3. 用户数据目录

**证据**：`%APPDATA%\DeepSeek Harness Desktop\dsh-home` 生成：
- `profiles/`（web profile 装配）与 `profiles/node_modules/`
- `storages/workspace.json`、`settings.yaml`、`.credentials.yaml`（credential 记录）、`.anonymous-user-id`

`productName: "DeepSeek Harness Desktop"` 缺省时 Electron 会退回 package.json `name`（`@deepseek-ai\dsh-desktop`），产生错误数据目录；已在 package.json 补齐 `productName` 并重建（本记录数据均在正确路径）。

## 4. 无 key 路径（纯 UI 自助配置）

**证据**：
- 后端子进程由 `resources\node\node.exe <bin.js> --profile web --no-open --port 0` 启动（backlog 可查），shell env 仅注入 `DSH_HOME`，不注入任何 `DEEPSEEK_*`。
- UI 已在壳内真实渲染并持久化：`settings.yaml` 出现 `ui-onboarding.welcomeNoticeVersion: 2026-08-13.1`（由 Web UI 写入 `$DSH_HOME`）。
- `.credentials.yaml` 已生成（`version: 1 / records:` 结构），说明设置页可写入 key 并落到 `$DSH_HOME`。
- 结论：**通过（UI 渲染 + 持久化链路）**；"设置页输入 key"的逐键点击未做人工验证，理由：无显示器桌面 + 模型无图像输入，无法目视/点击页面；链路证据由 onboarding 版本号持久化等价覆盖。

## 5. 复用：重启后会话/设置仍在

**证据**（同一 `%APPDATA%`，两次启动）：
- 第一次启动后 `settings.yaml` 含 `welcomeNoticeVersion`，`storages/workspace.json`（199 B）。
- 关闭后重新启动 → 新 ready URL（`127.0.0.1:65221`）→ `settings.yaml` 内容不变、`workspace.json` 仍在。
- 结论：**通过**。数据目录复用，未重建/清空。

## 6. 端口占用 / 壳级 --port 覆盖

**场景**：工作机上 `127.0.0.1:3080` 已被占用（DSH Web GUI 监听），以 `--port 3080` 启动 exe。

**证据**：
- `main.log`：`[main] backend readiness failed: backend exited with code 1 before readiness:`，尾部含 `EADDRINUSE ... port: 3080`（后端 stderr 已并入错误文本；本次修补前缺失，见 §记录）。
- 主进程保持存活并显示原生错误对话框（窗口类 `#32770`，标题 `Error`），直到用户确认；确认后 `app.exit(1)` 清理退出，无残留进程。
- 默认路径 `--port 0` 由 OS 分配，无冲突可能（D3）；壳级 `--port` 覆盖仅作调试，冲突时**明确报错**。
- 结论：**通过**（`--port 3080` 覆盖 + 占用冲突显式错误对话框）。

## 7. 体积 / 杀软

- exe 体积 220.6 MB（含 electron 运行时 + 后端装配体 + 独立 node.exe）。解包 `resources\dsh-runtime` 213.5 MB、`resources\node\node.exe` 81.3 MB。
- 未做代码签名，杀软（Windows Defender Real-time）首轮扫描 85 MB node.exe 可能导致便携提取阶段偶发文件缺失：首版 two-stage（Nsis7z extract + CopyFiles）实测在冷提取时丢过 `resources\node\node.exe`（shell 报 `spawn ... ENOENT`），已通过 `portable.useZip: true` 改为直接 `File /r` 内嵌单步提取，反复冷启动不再复现（§记录）。
- 杀软弹窗/拦截：本机未触发 SmartScreen/Defender 阻断；未签名告警无法在无显示器环境目视，记"未验证 + 原因"。

## 8. 记录（排查与修补）

- **P1.4 探针结论复核**：本机系统 Node v22.19.0（ABI 127）跑装配态 `lib/bin.js` 探针通过（ready 行 + 401，无 ERR_DLOPEN），与 D2 决策一致；打包版此后端由 `resources\node\node.exe`（随包独立 Node）承载，Electron 内置 Node（v24.20.0 ABI 149）仅作壳。
- **electron-builder 依赖修复**：`app-builder-lib@26.15.3` 读取 `@electron/get` 的 `ElectronDownloadCacheMode`（3.1.0 才导出）而声明 `^3.0.0`；锁旧 3.0.0 时 `Cannot read properties of undefined (reading 'ReadWrite')`。以 `pnpm-workspace.yaml` 覆盖 `app-builder-lib@26.15.3>@electron/get: 3.1.0`（空泛化更新会顺带刷新几百行无关锁条目，故用精确覆盖）。
- **提取竞态**：portable 默认 two-stage（Nsis7z 解到 `$PLUGINSDIR\7z-out` → CopyFiles 到 `$TEMP\<unpackDirName>`，extractAppPackage.nsh）在冷启动偶发丢 `node.exe`（收件机首轮扫描新落盘大文件时）。`portable.useZip: true` 走 portable.nsi 的 `File /r` 单步内嵌，规避 staged copy；代价是 exe 由 130.8 MB 增至 220.6 MB（NSIS 内置 zlib 压缩 vs 7z LZMA）。
- **readiness 失败静默退出**：后端在打印 ready 行前退出（如 EADDRINUSE）时，壳原实现仅 `app.quit()` 静默关窗，无错误提示，违反"明确错误提示"。修补：`src/backend.ts` 在 exit 事件且未 settled/未 dispose 时 reject ready，错误文本附后端 stdout+stderr 尾部；`src/main.ts` 的 `onExit` 仅在已就绪后端崩溃时关窗。验证：`--port 3080` 冲突 → 日志带 `EADDRINUSE ... port: 3080` + 原生错误对话框。
- **未验证项**：正式 .ico（默认 Electron 图标 + 警告）；代码签名/杀软白名单。