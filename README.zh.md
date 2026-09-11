# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

<a id="run-the-windows-desktop-app"></a>

### 运行 Windows 桌面应用

首次使用时，先按[桌面配置指南](apps/desktop/README.zh.md#windows-cold-start-from-a-fresh-state)构建并暂存桌面运行时。依赖已安装、运行时已暂存后，在 CMD 或 PowerShell 中从仓库根目录执行：

```cmd
cd apps\desktop
npm start
```

`npm start` 使用已安装的依赖执行 Electron 启动脚本。如需使用 pnpm，在 `apps/desktop` 目录执行：

```cmd
pnpm --config.verify-deps-before-run=false start
```

该 pnpm 参数只关闭本次启动前的依赖检查。在 pnpm 11.7.0 中，生产模式的工作区状态可能使该检查执行 `install --production`，移除 Electron 等开发依赖。

如果这些依赖已被移除，在启动前从仓库根目录恢复：

```cmd
pnpm install --prod=false --frozen-lockfile --config.confirmModulesPurge=false
node apps/desktop/node_modules/electron/install.js
```

安装命令按现有锁文件恢复依赖；第二条命令确保 Electron 可执行文件可用。仅在依赖缺失时执行这些恢复命令。

## 从全新检出开始构建、启动与打包

在 Windows PowerShell 中，从仓库根目录执行下面的命令完成桌面应用的全新配置。根目录的 `build` 命令会构建 Host、Client 与 Web 产物；`assemble` 会暂存桌面壳所需的后端闭包与独立 Node 运行时。

### 从零构建并启动

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:HTTP_PROXY='http://127.0.0.1:7897'
pnpm install --config.confirmModulesPurge=false
pnpm --filter @deepseek-ai/dsh-desktop build
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop assemble
pnpm --config.verify-deps-before-run=false --filter @deepseek-ai/dsh-desktop start
```

如果安装后仍缺少 `apps\desktop\node_modules\electron\dist\electron.exe`，在 `apps\desktop` 目录执行一次下面的命令，然后返回仓库根目录：

```powershell
node node_modules\electron\install.js
```

### 从零构建便携式可执行文件

先完成构建与暂存，再执行便携式可执行文件打包：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$env:HTTP_PROXY='http://127.0.0.1:7897'
pnpm install --config.confirmModulesPurge=false
pnpm --filter @deepseek-ai/dsh-desktop build
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop assemble
$env:CI='true'
$env:npm_config_ignore_scripts='true'
pnpm --filter @deepseek-ai/dsh-desktop dist
```

`CI` 与 `npm_config_ignore_scripts` 会让 Electron Builder 内部的生产依赖安装在非交互模式下运行，并避免生产依赖裁剪后再次执行根目录开发依赖的 postinstall hook。打包后的可执行文件写入 `apps\desktop\release\`。`.runtime\`、`.runtime-node\`、`.runtime-pack\` 与 `release\` 都是本机生成的构建产物，全新检出后需要重新生成。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
