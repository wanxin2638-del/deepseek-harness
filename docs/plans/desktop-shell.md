# Plan 1 · 桌面壳（Electron）工程

> 工作规划文档，不属于 `docs/` 发布树：不注册 doc-sync leaf、不进 website 投影、不做中英配对。
> 配套 [Plan 2 · 桌面集成能力](desktop-integration.md)（通知/任务栏闪烁等，依赖本计划落地）。
> 本计划只做"壳 = 宿主"，不做任何产品逻辑。

## 1. 定位与目标

把官方原版 DSH 变成 Windows 桌面 exe。当前产品形态是 `dsh --profile web` 在 `127.0.0.1` 上提供完整 Web GUI（页面 + `/api` RPC + 事件流 + 静态 UI）。目标形态：

- **双击即用**的 Windows x64 portable exe（绿色免安装单文件）。
- **全内置**：exe 内含 Electron 壳、Node 运行时、dsh 后端装配体（`lib` + `node_modules` + UI dist）。
- **收件机零环境要求**：无需 Node / pnpm / Python / git；Windows 10/11 x64 即可（dsh 在 Windows 的 shell 工具走系统自带 PowerShell，见 §3 事实 F9）。
- **集成式**：壳自动拉起后端、自动完成登录交换、退出时清理全部子进程树。

## 2. 设计原则（对齐仓库规则）

| 原则 | 含义 |
|---|---|
| **壳是宿主，不是插件** | `webserver` 包 JSDoc 已把 Electron 定义为宿主（`packages/host/webserver/src/index.ts:4`）。壳不做产品逻辑，只做编排：spawn、就绪解析、登录、导航限制、退出清理。 |
| **遵守 application-launch 规则** | 任何 Node 应用只能经 `dsh` CLI + 命名 profile 启动（`docs/architecture.md#application-launch`，`verify-application-entrypoints` 门禁）。壳必须 `spawn(<node>, [<lib/bin.js>, '--profile', 'web', ...])`，禁止自建 Node 入口。 |
| **一切皆插件不变** | 产品能力（通知、任务栏闪烁等）全部留给 Plan 2 的插件层；壳只暴露最薄的桥。本计划不实现任何"任务状态"感知。 |
| **走 http loopback，不用 file://** | 认证（token→cookie）、browser-trust 栅栏、`/api` 都按 http origin 设计（Origin `null` 被拒，见事实 F5）。壳用 `loadURL(token URL)` 完成交换，Electron 默认 session 持久化 cookie。 |

## 3. 已证实契约（决策事实）

以下均在本仓库源码逐行核实，作为 P1.2–P1.5 的唯一事实来源。

**F1 · 就绪行** — `packages/bundle/web-app/src/index.ts:280` 打印
`dsh web: http://127.0.0.1:<port>/?token=<base64url>`
- 打印时机在 Loader 树 settle 之后（`:263-305`），即 `/api` 等兄弟行已挂载完，收到该行即可 GET/RPC。
- `printUrl: true` 在 web bundle patch 写死（`packages/bundle/web-app/cordis.patch.yml:140`）。
- 行尾仅当有 LAN 地址才追加 ` (LAN: <url>)`；而 LAN 只在 `--host 0.0.0.0` 时出现，该值被拒绝（F3），故实际无 LAN 后缀。壳解析：扫描 stdout 行，匹配 `^dsh web: ` 前缀取首个 `http://...` token；不得假定为第一行（前面可能有 boot/telemetry 日志）。

**F2 · 登录交换** — `packages/client/connection/src/browser-auth.ts`
- token：进程级一次性，base64url 32 随机字节，按进程 root WeakMap 保留（`:52-58`），`authenticatedUrl` 拼 `?token=`（`:223-230`）。
- GET 带 token 的 `/` → `303` + `location: /` + `Set-Cookie`（HttpOnly、SameSite=Strict、绑定 Host authority，`:256-263, :70-78, :289-302`）→ 落到干净首页。
- cookie 名 `dsh-auth-<sha256(authority)>`，有效期 `cookieMaxAgeDays`，web profile 未配置 → schema 默认 **30 天**（`packages/client/connection/src/index.ts:88-91`）。
- **`/api` 只认 cookie**：`requestRejection` 先 Host/Origin 栅栏再 `isAuthenticated`（`packages/client/connection/src/rpc-host.ts:97-100`）。query token 只认证 index，不能直接 RPC。壳必须完成一次 `loadURL(token URL)` 交换。

**F3 · 旗标** — `packages/bundle/web-app/src/startup.ts:46-87`
- `--no-open`（抑制默认浏览器 spawn，壳**必须传**，否则后端会用 `process.execPath --eval` 起一个浏览器 opener，`:182-191`）；`--port <n>`（`0` = OS 分配）；`--host <h>`；`--trusted-host`。
- **`--host 0.0.0.0` 启动期被拒**（`:74-76`）。默认 host `127.0.0.1`、默认端口 3080（patch 惰性表达式 `cordis.patch.yml:120-121`）。

**F4 · env 链与 DSH_HOME** — `packages/boot/app-boot/src/index.ts:198-216`、`packages/util/home-paths`
- 读取链：继承的 process.env > 调用目录 `.env` > `$DSH_HOME/.env`；低层不覆盖高层。
- **`DSH_HOME` 是 bootstrap-only，任何 `.env` 都不能设置它** —— 壳必须显式 `env: { DSH_HOME: <userData>/dsh-home }` 注入。默认值 `~/.dsh`。
- `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 可在 `.env` 声明；壳**不注入**任何 `DEEPSEEK_*`（key 引导由 Web UI 自理，见 Plan 2 的契约依据）。

**F5 · browser-trust 栅栏** — `packages/client/connection/src/api-request-trust.ts:91-118`
- Host 必须 loopback 或声明过的 trustedHost；`sec-fetch-site: cross-site` 拒绝；Origin 若存在必须等于 Host；**Origin `null` 拒绝**（禁用 `file://`、沙箱 iframe）。Electron renderer 对 loopback 的同源 fetch 天然通过，保持 `webSecurity` 默认开启即可。

**F6 · 装配态 UI 静态资源** — `packages/bundle/web-app/src/index.ts:171-179`
- `resolveDistIndex()` 锚定在 `@deepseek-ai/dsh-web-frontend/package.json` 邻居 `dist/index.html`；该包是 `@deepseek-ai/dsh-web-app` 的 dependencies。装配体只要依赖闭包带上该包且含 `dist/index.html` 即工作。

**F7 · 启动链路** — `apps/cli/package.json`
- `@deepseek-ai/dsh`，`"bin": { "dsh": "lib/bin.js" }`，`files: ["lib/*.js"]`，ESM。
- 源码态（仓库内 `pnpm dsh`）走 tsx ESM hook；**装配态 `lib/bin.js` 是纯编译产物，直接 `node lib/bin.js` 即可，无 tsx 依赖**（P1.4 实测复核）。

**F8 · profile 机制** — `packages/boot/app-boot/src/profile.ts`
- profile 目录 `$DSH_HOME/profiles/<name>`；`web` 模板 = bundles `[dsh-base, dsh-web-app]`，`patchReload: live`（`:137-158`）。
- `dsh plugin --profile web add <pkg>` 可加 out-of-tree 插件；`$DSH_HOME/cordis.patch.yml` 是 home 层补丁（热重载）。壳首次启动前注入 `DSH_HOME` 即可让 `dsh --profile web` 自动初始化该目录。

**F9 · Windows 运行面**
- web profile 在 win32 **关 bash、开 pwsh**（`packages/bundle/base/cordis.patch.yml:220-258`）。
- `dsh-pwsh-local` 自动发现：显式 `pwshPath` 未设时查 Windows 安装路径，含 **Windows PowerShell 5.1（powershell.exe）**，再回退 PATH 上的 `pwsh`（`packages/shell/pwsh-local/src/index.ts:72-77`）。→ 干净 Win10/11 **无需任何额外安装**。
- code-runtime 不在 web profile → **不需要 Python**。

**F10 · 原生依赖（装配 ABI 风险）** — `pnpm-workspace.yaml allowBuilds`
- 运行时闭包含原生模块：`koffi`（JSONL `MoveFileExW` write-through 发布）、`fs-ext`（session 写锁 `LockFileEx`）、`node-addon-require-builtin`（win32-x64-msvc prebuild）。`node-pty`（PTY）不在 web profile 闭包内。
- **P1.4 实测裁决 D2（本行替代旧预测）**：系统 Node v24.0.0（ABI 137）跑装配态 `lib/bin.js` → 就绪行 + `GET /` 401 + 全程无 `ERR_DLOPEN`，探针通过。Electron 44.2.0 内置 Node v24.20.0（ABI 149）经 `ELECTRON_RUN_AS_NODE=1` 跑同一闭包 → `fs-ext` 加载即 `ERR_DLOPEN_FAILED`（`NODE_MODULE_VERSION 149`，nan+node-gyp 非 N-API，栈在 `fs-ext.js:22`）。`koffi`（cnoke `"napi": 8`）与 `node-addon-require-builtin`（N-API prebuild）未报错，ABI 兼容结论成立。→ **D2 首选不成立，回退独立 node.exe**（shell 打包路径 `resources/node/node.exe`，P1.5 已按此实现，体积 +~50MB）。

**F11 · 应用层最低文件面与根 gate 扫描面** — P1.1 复核
- `apps/cli` 与 `apps/web` 的最低文件面：`package.json`（`name` `@deepseek-ai/dsh-*`、`"type": "module"`、`publishConfig.access: public`、`repository.directory`、`files`、`dependencies`/`devDependencies`）、`tsconfig.json`（extends `../../tsconfig.base.json`，`rootDir`/`outDir: lib/types`，`references` 指向 workspace 依赖）、`src/`、`tests/`、`README.md`。无包级 `.gitignore`（`lib/` 与 `apps/web/dist/` 由根 `.gitignore` 兜底）。
- **`verify-application-entrypoints`**（`scripts/verify-application-entrypoints.ts`）扫描 `apps/*/package.json` 的 `bin`：只允许 `apps/cli` 与 webworker-packer 的已分类 bin；`apps/desktop` **不得声明 `bin`**。同时扫描 `apps/**/*.{ts,js,mjs,cjs}` 的 `#!` shebang（排除 `node_modules`/`lib`/`dist`）——`src/main.ts` 不能以 `#!` 开头。
- **`verify-package-dependencies`**：每个新包需要 `@deepseek-ai/cordis` 的 peer+dev 依赖（若参与 cordis）。Electron 壳不加载 cordis 插件，仅作为独立宿主，故 `apps/desktop` 可不声明 cordis，但要过 `hygiene` 的依赖校验（`verify-package-dependencies` 与 `verify-dsh-package-licenses`）。
- **`typecheck`**：新 `apps/desktop` 需被某 tsconfig 项目引用或独立编译；`apps/web` 与 `apps/cli` 不在同一 solution 根（各自独立 `tsconfig.json`），`apps/desktop` 同法独立 `tsconfig.json`。
- **`doc-sync`/`website`**：`docs/plans/` 不注册 leaf、不进 website 投影（§1 已声明）；新增 `apps/desktop/README*` 需按 `verify-package-readme-model-experience` 与 `verify-package-readme-limitations` 处理（包 README 属 package README tier，需 Model Experience 段落与 Known Limitations）。
- **`clean`**（`pnpm run clean`）：清理 build 产物与已删包的残留；需覆盖 `apps/desktop` 的 `lib/`、`.runtime/`、`release/`（P1.8 处置）。
- **`duplication`**（跨文件 TS 克隆检测）：`src/main.ts` 的 spawn/就绪解析/清理逻辑需避免与仓库其它子进程编排克隆，P1.8 证明或排除。

## 4. 目标架构

```
│  main.js（apps/desktop/src/main.ts 编译）                             │
│  · resolveBackendLaunch()：dev 态 apps/desktop/.runtime/；            │
│    打包态 process.resourcesPath/dsh-runtime/                          │
│  · env：{ ...process.env, DSH_HOME: <userData>/dsh-home }（P5 起）     │
│  · spawn(<node>, [<bin.js>, '--profile', 'web',                      │
│      '--no-open', '--port', '0'])    ← F3 旗标 + F1 就绪解析          │
│  · 扫 stdout 匹配 `dsh web: <url>` → loadURL(url)                    │
│    → 303+Set-Cookie → 干净首页（F2）                                   │
│  · will-navigate / setWindowOpenHandler：外域走 shell.openExternal    │
│  · before-quit / 崩溃：kill 后端进程树（taskkill /T）→ 无孤儿          │
│  · 日志：userData/logs/main.log + backend.log                         │
└───────────────┬───────────────────────────────────────────────────────┘
                │ spawn（同一个 electron.exe，ELECTRON_RUN_AS_NODE=1，
                │   或独立 node.exe —— 见决策 D3）
┌───────────────▼───────────────────────────────────────────────────────┐
│  dsh 后端装配体（pnpm deploy 离线装配，解包在 resources/dsh-runtime，  │
│  不入 asar）                                                            │
│  lib/bin.js + node_modules + @deepseek-ai/dsh-web-frontend/dist        │
│  → 提供 / 与 /api、事件流、静态 UI（F6）                                │
└────────────────────────────────────────────────────────────────────────┘
```

## 5. 决策表

| # | 决策 | 选项与推荐 | 依据 |
|---|---|---|---|
| D1 | 壳工程位置 | 仓库 `apps/desktop`，包名 `@deepseek-ai/dsh-desktop`（`pnpm-workspace.yaml` 已 glob `apps/*`） | 与 apps/cli、apps/web 并列的应用层；壳非插件 |
| D2 | 后端 Node 运行时 | **已裁决：随包独立 node.exe**（`ELECTRON_RUN_AS_NODE` 首选不成立，P1.4 探针实证） | P1.4 探针：系统 Node ABI 137 通过；Electron 内置 Node ABI 149 下 `fs-ext` `ERR_DLOPEN_FAILED`（详见 F10） |
| D3 | 后端启动命令 | `spawn(<node>, [<bin.js>, '--profile', 'web', '--no-open', '--port', '0'])` | F1/F3/F7；`--port 0` 由 OS 分配，就绪行给出实际端口，天然免冲突 |
| D4 | 用户数据 | `DSH_HOME = app.getPath('userData')/dsh-home`，壳 env 注入 | F4；隔离用户 patch / sessions / 凭据 |
| D5 | 登录交换 | `loadURL(authenticatedUrl)` 一次完成 | F2/F5 |
| D6 | 端口 | 默认 `--port 0`（OS 分配）；保留壳级 `--port <n>` 覆盖供调试 | 免冲突；cookie 按 authority 绑定，每启动新端口会重发 cookie，因交换自动所以用户无感 |
| D7 | 退出清理 | `before-quit` 杀进程树（Windows `taskkill /pid <pid> /T /F` 兜底），单实例锁 `requestSingleInstanceLock` | 防孤儿、防多开 |
| D8 | 打包目标 | electron-builder `win.target: portable`；`asar: true` 仅壳 main；`extraResources` 装 dsh-runtime（解包，不能进 asar） | 后端要 `require.resolve` 与原生模块，须真实文件系统 |

## 6. 任务拆解

通用约定：工作目录 `E:\ai\deepseek-harness`；每个任务结束 `git commit`（信息带 P#），并更新本文件 §8 状态表。

### P1.1 契约调研收尾（只读）
- 写路径：仅本文件（§3 事实表回填）+ 无其它写。
- 复核清单：
  1. F4 `DSH_HOME` bootstrap-only 名单精确行号（`packages/boot/app-boot/src/index.ts:100-130`），确认壳必须 env 注入的结论。
  2. F7 源码态 vs 装配态启动命令各给一条**可执行探测命令**（源码态 `node --import tsx/esm apps/cli/src/bin.ts ...`；装配态 `node <deploy>/node_modules/@deepseek-ai/dsh/lib/bin.js ...`）。
  3. F10：确认 `fs-ext` / `koffi` 是否 N-API（`node -e "console.log(process.versions.modules)"` 对照），决定 D2 首选是否成立；列出 web profile 闭包内**全部**原生模块名单（`pnpm why` / deploy 后扫描 `.node` 文件）。
  4. `apps/cli` 与 `apps/web` 的"应用层最低文件面"（package.json 字段、tsconfig 继承、README 形态、私有/发布标记），供 P1.2/P1.8 用。
  5. 根 gate 对 `apps/` 与 `docs/plans/` 的扫描面（`scripts/run-gates.ts`：typecheck / lint / hygiene / duplication / doc-sync / website / clean），列出新目录会触发哪些失败。
- 验收：§3 事实表全部补完行号；未决项标注"留待实测"+ 探测命令；`git commit`。

### P1.2 apps/desktop 工程骨架
- 写路径：`apps/desktop/`（package.json、tsconfig.json、.gitignore、src/main.ts 空窗、src/preload.ts 占位、README 骨架）。
- 要点：
  - 包名 `@deepseek-ai/dsh-desktop`；`"main": "lib/main.js"`，`"type": "module"`，tsc NodeNext 编译 `src/` → `lib/`。
  - devDependencies：`electron`（版本按 P1.1 复核的 Electron/Node 匹配区间）。
  - scripts：`build`（tsc）、`start`（`electron .`）。
  - 窗口安全基线写进骨架：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、**禁** `webSecurity: false`；不引入任何 preload 桥接（说明：UI 是受信任 loopback 页面，壳只做编排；Plan 2 再单独设计桥）。
  - `.gitignore`：`lib/`、`.runtime/`、`release/`、`*.log`。
- 验收：`pnpm install` 成功；`pnpm --filter @deepseek-ai/dsh-desktop build` 产出 `lib/main.js`；`start` 能起空窗口（无显示环境则记录现象 + `electron --version` 等价证据）。
- 风险：electron 二进制下载失败 → 镜像变量重试（`ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`）。

### P1.3 主进程 v1（dev 拉源码态后端）
- 写路径：`apps/desktop/src/main.ts`（+ 必要小模块）。
- 要点：
  - 后端启动：按 P1.1 结论用源码态命令 + `--profile web --no-open --port 0`（F1/F3/F7）。
  - stdout 解析：按 F1 正则扫描（非首行）；60s 超时未出现就绪行 → 错误对话框 + 日志，不静默。
  - 端口：默认 `--port 0`；壳级 `--port <n>` 覆盖。
  - 窗口：加载解析到的 URL；`will-navigate` / `setWindowOpenHandler` 限制（外域 → `shell.openExternal`，回环放行）。
  - 退出清理：`before-quit` / `window-all-closed` / 主进程崩溃时 kill 后端进程树（D7）。
  - 预留 `resolveBackendLaunch()` 接口，P1.5 切换装配态。
- 验收：`start` 拉起后端（日志出现 `dsh web:` 行）→ 窗口出现 dsh GUI 首页（完成 401→cookie 交换，可用 curl 对照：无 token GET `/` 得 401、壳内页面正常）→ 关窗后无残留后端进程；端口占用错误提示可见。
- 风险：源码态启动链路与 F7 不符 → 以实际日志修正命令并回填本文件。

### P1.4 后端装配 runtime
- 写路径：`apps/desktop/scripts/assemble.mjs`、`apps/desktop/.runtime/`（gitignore，不入库）。
- 要点：
  - 前置构建（P1.1 给最小集合）：各 workspace 包 `lib/` + `apps/web` dist（`@deepseek-ai/dsh-web-frontend` 的 dist，F6）；脚本先做存在性检查，缺失即报"请先构建"。
  - 装配：`pnpm --filter @deepseek-ai/dsh deploy <apps/desktop/.runtime>`（先清空、幂等）；输出目录摘要（bin 路径、node_modules 布局、UI dist 是否就位、总大小）。
  - **ABI 探针（D2 的裁决点）**：在干净子进程（脱离仓库 cwd）用目标 node 跑装配态 bin，确认（a）能启动并打出 `dsh web:` 行；（b）原生模块（fs-ext / koffi / node-addon-require-builtin，F10）加载无 `ERR_DLOPEN`。失败 → 回退 D2 备选（独立 node.exe），记录结论回填本文件。
  - 环境：装配触网失败 → `--offline`（store 已在仓库 install 时具备）。
- 验收：脚本可重复执行；目录结构/大小记录；独立验证输出 `dsh web:` 且 `curl -sI` 得 401（活着）后正常终止；`.runtime/` 被 gitignore。
- 风险与回退：pnpm deploy 对 private/vendor workspace 包行为不符 → 备选：逐包 `pnpm pack` staging + `npm install --offline`；仍失败 → blocked 并附现象。

### P1.5 主进程 v2（装配态 + DSH_HOME 注入）
- 写路径：`apps/desktop/src/main.ts` 改造。
- 要点：
  - `resolveBackendLaunch()`：dev → `apps/desktop/.runtime/`；打包态 → `process.resourcesPath/dsh-runtime/`（P1.6 落盘路径）。
  - 启动：`spawn(<node>, [<bin.js>, '--profile', 'web', '--no-open', '--port', '0'], { env: { ...process.env, DSH_HOME: <userData>/dsh-home }, windowsHide: true })`（D2/D3/D4）。
  - 无 env key 路径验证（纯 UI 自助配置，见 Plan 2 §4 事实）：不注入任何 `DEEPSEEK_*`，UI 设置页能加 key 并持久化到 `DSH_HOME`。
  - 端口/错误/退出清理沿用 P1.3。
- 验收：dev 下走装配态启动，就绪行来自 `.runtime/` 后端；窗口完成交换进首页；`<userData>/dsh-home` 生成且 UI 配置可持久化；关窗无残留。
- 风险：`ELECTRON_RUN_AS_NODE` 行为异常 → D2 备选独立 node.exe（注明代价：体积 +~50MB）。

### P1.6 electron-builder 打包 portable exe
- 写路径：`apps/desktop/electron-builder.yml`、`release/`（gitignore）、`scripts/`（图标/资源准备）。
- 要点：
  - devDependencies 加 `electron-builder`；scripts 加 `dist`。
  - 配置：`appId`、`productName`、`directories.output: release`、`files`（壳 lib + package.json + assets，不含 .runtime）、`extraResources`（`.runtime/` → `resources/dsh-runtime`，必须解包不能进 asar）、`win.target: portable`、`asar: true`、`npmRebuild: false`、`electronLanguages`/`compression` 视体积。
  - 图标：无资源先不配（默认图标 + 告警），P1.8 记录"正式发布需 .ico"。
  - 下载兜底：二进制下载失败按 P1.2 镜像变量重试。
- 验收：`release/` 产出 `*portable.exe`；记录文件名与体积；无致命错误。
- 风险：portable 目标依赖 nsis 下载失败 → 降级 `win.target: dir` 验证链路后如实说明。

### P1.7 产物冷启动验证
- 写路径：`docs/plans/notes/verification-shell.md`（新建）。
- 收件人视角清单（逐项证据）：
  1. 冷启动：非仓库目录、PATH 临时移除 node/pnpm 后运行 exe → 窗口出现并完成交换进首页。
  2. 生命周期：`tasklist` 观察关窗后无残留 electron/后端进程。
  3. 用户数据：`%APPDATA%/<ProductName>/dsh-home` 出现预期文件（sessions / settings）。
  4. 无 key 路径：未配置 env，UI 设置页可加 key 并持久化。
  5. 复用：重启 exe，会话/设置仍在。
  6. 端口占用：预先占用 3080 场景 → 明确错误提示（`--port 0` 下应无此问题，改为验证壳级 `--port 3080` 覆盖路径）。
  7. 体积/杀软：记录体积与告警情况。
- 验收：verification-shell.md 每项给命令/证据或"未验证+原因"。

### P1.8 收尾：文档与仓库合规
- 写路径：`apps/desktop/README*`、本文件状态表、gate 白名单/注册（如需要）。
- 要点：
  - README（用法：assemble → start/dist、产物说明、配置、局限：生命周期随壳、数据目录、未签名、图标缺失、体积）。
  - gate 处置：`clean` 是否清理 apps/desktop 产物并同步；`typecheck`/`lint` 局部通过；`duplication` 排除或证明无命中；`doc-sync`/`website` 对 `docs/plans/` 与新增 README 的处置（排除/注册，按 P1.1 结论选最小合规路径）；`hygiene` 核对 package.json。
  - 本地只跑受影响的最小 gate 子集，逐个记录。
  - 最终 diff 自查：`git status` 只剩预期文件；无 `.runtime/`、`release/`、node_modules 泄漏入库。
- 验收：apps/desktop 结构完整；列出的 gate 通过或有书面豁免；交付总结（中文）。

## 7. 非目标

- 不做任何"任务状态 → 提醒"逻辑（Plan 2）。
- 不做自动更新、代码签名、正式图标（记录为已知限制）。
- 不做 LAN 服务（`--host 0.0.0.0` 被拒，F3）。
- 不内置 terminal/PTY、e2b、LSP（不在 web profile 闭包，F9）。
- 不做壳级多语言 UI（产品文案归 Web UI 的 locale 体系）。

## 8. 状态表

| 任务 | 状态 | 完成日期 | 备注 |
|---|---|---|---|
| P1.1 契约调研收尾 | 已完成 | 2026-09-06 | 见 §3 复核记录 |
| P1.2 工程骨架 | 已完成 | 2026-09-06 | 见 §8 备注；Electron 44.2.0 经 npmmirror 装妥 |
| P1.3 主进程 v1 | 已完成 | 2026-09-06 | dev 源码态后端；就绪解析/登录交换/退出清理已实测 |
| P1.4 后端装配 | 已完成 | 2026-09-07 | `deploy-root` 闭包清单（228 个 workspace 包）+ `scripts/assemble.mjs`（deploy→restoreLegacyHoists→materializeStagedLinks→摘要→ABI 探针）；`.runtime/` 212.1 MB；D2 已由探针裁决（见 F10） |
| P1.5 主进程 v2 | 已完成 | 2026-09-07 | `resolveBackendLaunch()` 切装配态（dev `.runtime/`、打包 `resources/dsh-runtime` + `resources/node/node.exe`）；`DSH_HOME = userData/dsh-home` env 注入；dev 实测：就绪行来自 `.runtime` 后端、`dsh-home` 生成、关窗无残留 |
| P1.6 打包 | 已完成 | 2026-09-07 | `electron-builder.yml` + `assemble` 扩展（`.runtime-pack/` 嵌套 payload、`.runtime-node/` node.exe 暂存、探针 home 移出 payload）；`portable.useZip: true` 单步内嵌规避提取竞态；产物 `DeepSeek Harness Desktop 0.1.3-alpha.1.exe` 220.6 MB；依赖/竞态/readiness 修补见 [verification-shell.md §8](notes/verification-shell.md) |
| P1.7 冷启动验证 | 已完成 | 2026-09-07 | 见 [notes/verification-shell.md](notes/verification-shell.md)；冷启动/生命周期/用户数据/无 key 路径/复用/端口占用/体积逐项取证 |
| P1.8 收尾 | 已完成 | 2026-09-07 | README 补全（Model Experience + Known Limitations）；`constraints` 注册 `appPackageFiles` 并补 release 元数据；desktop oxlint 清零；README/dedup/md-links/constraints 通过；hygiene 剩 2 项预存失败（built invariants、cordis-config，清树可复现，与本分支改动无关） |

### 交接记录（2026-09-07 · 换机继续用）

- **已提交**：P1.1–P1.5 全部入库；本分支 `dev`。下一台机器：`git pull` → `pnpm install` → `pnpm run build` + `pnpm run build:web` → `pnpm --filter @deepseek-ai/dsh-desktop assemble` → `pnpm --filter @deepseek-ai/dsh-desktop start`（`.runtime/` 与 `release/` 是本机产物，不入库，需重新 assemble）。
- **环境事实（本机）**：Node v24.0.0 ABI 137；Electron 44.2.0 内置 Node v24.20.0 ABI 149（D2 因此回退独立 node.exe）；pnpm v11.7.0（`pnpm.cmd`，pwsh 禁脚本）；electron 二进制下载不可达时 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，必要时代理 127.0.0.1:7897；npm registry 直连可达。
- **注意事项**：`assemble.mjs` 的 deploy 目标必须传绝对路径（相对路径的 legacy deploy 会在 workspace 包内生成 junk 树——本次已清理 `vendor/schemastery/apps` 残留，勿再触发）；探针旗标经 pnpm 转发形如 `pnpm --filter @deepseek-ai/dsh-desktop run assemble -- --electron-probe`；PowerShell 下 `pnpm.cmd ... 2>&1` 会把 pnpm 的 stderr banner 显示为 NativeCommandError（属误报，判定退出码用 `1> out 2> err; $LASTEXITCODE`）。
- **待办（后续机器）**：本分支 `dev` 已含 P1.1–P1.8 全部实现与验证记录。新机器流程：`git pull` → `pnpm install` → `pnpm run build` + `pnpm run build:web` → `pnpm --filter @deepseek-ai/dsh-desktop assemble` → `start`（`.runtime*` 与 `release/` 是本机产物，不入库，需重新 assemble）；`dist` 前需 `ELECTRON_MIRROR`（npmmirror）与 `ELECTRON_BUILDER_BINARIES_MIRROR`。Plan 2（通知/任务栏）可在本计划产物上加载。

## 9. 风险汇总

| 风险 | 影响 | 缓解 |
|---|---|---|
| 原生模块 ABI 与 Electron Node 不兼容（F10） | 后端启动失败 | P1.4 探针前置裁决 D2；回退独立 node.exe |
| pnpm deploy 对 private/vendor workspace 包行为不符 | 装配失败 | P1.4 备选 pack+offline 装配 |
| 二进制下载（electron/nsis） | 构建失败 | 镜像变量重试 |
| 体积 150–400MB | 分发体验 | P1.6 记录，P1.8 说明 |
| 未签名杀软误报 | 分发受阻 | P1.8 说明 + 正式发布需签名 |
| 端口冲突 | 启动失败 | `--port 0`（D3）+ 明确错误提示 |
| 仓库 gate 扫描新目录 | CI 红 | P1.1 摸清 + P1.8 统一处置 |