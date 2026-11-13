# DSH MCP Proxy

[English](README.md) | 中文

本项目提供 Windows 本地 MCP 连通应用及可单独安装的 DSH 服务端插件。本地应用可连接多个 DSH，共用一份本地 MCP 列表，并将每次调用与回调严格绑定到来源 DSH。应用不提供文件工具，本地操作由配置的下游 MCP 完成。

## 需求与后续开发

| 文档 | 内容 |
| --- | --- |
| [已确认需求](docs/requirements.md) | B1—B28、独立化要求、MCP 能力范围与非目标 |
| [现行技术方案](docs/design.md) | 两端职责、配对、轮次/来源绑定、取消、回调与恢复 |
| [配置与运行](docs/configuration.md) | 两端安装、完整示例、配置预算、禁用/卸载及诊断 |
| [验收与待完成](docs/acceptance.md) | 逐项需求覆盖、已执行证据、复现步骤及剩余开发/验收 |
| [完整历史基线](docs/history/README.md) | 已确认需求和方案 A 的中英文全文、后续变更与导入哈希 |

后续开发从需求编号和验收待办开始，不依赖原仓库或聊天记录。已实现、自动测试覆盖和最终产品验收分别记录；当前尚未完成全部联合验收。所谓接入任意 MCP 限于文档列明的传输及能力，resources/prompts 不在本期范围。

## 开发

新机器准备、独立 DSH profile、本地 TLS 和源码断点见[开发调试指南](docs/development.md)。
贡献流程见 [CONTRIBUTING](CONTRIBUTING.md)，敏感问题见 [SECURITY](SECURITY.md)。
安装依赖后执行 `pnpm dev:doctor`、`pnpm dev:init`；分别使用 `pnpm dev:server`、
`pnpm dev:desktop` 启动原生开发环境。Windows CI 在无生产密钥的环境验证安装、测试及两端打包。

`pnpm build:mcp-proxy` 后可运行 `pnpm test:product`：自动绑定构建记录中的 EXE/runtime，
要求 5 项原生产物测试全部通过，并检查服务位及测试数据清理。运行前需正常退出占用本机服务位的应用。
release CI 在两端打包后自动执行，详见[验收指南](docs/acceptance.md)。

`pnpm test:browser` 验证真实 Chrome/Edge 协议确认、自动配对及 GUI/托盘生命周期。
需要活动 Windows 会话、交互桌面、Explorer 托盘及空闲服务位/用户与系统 URI 注册；`--preflight` 安全检查，绝不覆盖现有安装。
release CI 要求两种浏览器各七场景及网页伪确认/托盘遮挡拒绝检查全部执行，不以跳过算成功；[已验证范围](docs/evidence/browser-desktop-e2e-2026-11-13.md)与未覆盖矩阵分别记录。

使用 Node.js 22.19+ 或 24+，以及 pnpm 11.7.0。依赖均来自公共 npm 仓库，不需要 Harness 源码目录。

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

在受影响的 Windows Node 24 版本上，发布构建和测试会自动在 `.artifacts/` 准备固定版本并经过校验的独立 Node，不修改全局安装。首次使用需要联网。

## 构建交付物

```sh
pnpm build:mcp-proxy
pnpm build:mcp-plugin
```

第一条命令需要 Windows x64，生成包含 Electron 和全部运行依赖的 `release/mcp-proxy/mcp-proxy.exe`。第二条生成 `release/mcp-plugin/`，包含单个插件 tarball、`install.mjs`、发布元数据和兼容补丁。中间文件保存在 `.artifacts/`。`--skip-build` 复用已编译的库；EXE 构建还支持 `--electron-dist`、`--node-license` 和 `--connection-presets`，用于显式指定构建输入。

构建还在 `release/mcp-proxy/` 生成一个较小的 Node profile 运行归档，供消费侧仅使用产物进行集成测试，不是 Windows 用户的额外安装步骤。产物测试通过 `MCP_PROXY_PRODUCT_TESTS=1` 显式启用，需要空闲的本机服务位，测试源码列出了经过校验的 Electron 产物输入。

## 安装与使用

在运行下游 MCP 的电脑打开 `mcp-proxy.exe`，应用自动启动服务并注册 `mcp-proxy://`。通过 GUI 添加 MCP 命令或 HTTP/SSE 地址，再从各 DSH 网页点击“连接这台电脑”。有效激活会自动连接，GUI 支持逐个 DSH 手动断开。关闭窗口后缩小到托盘，托盘“退出”直接停止所属服务，不再二次确认。

插件面向 DSH `0.1.6-alpha.2`。先停止服务，再对 **DSH 的包管理安装根目录** 运行发布安装器，不能填写 profile 目录：

```sh
node release/mcp-plugin/install.mjs --dsh-root <dsh-installation-root>
```

使用自定义 profile home 时设置 `DSH_HOME`。`--profile` 默认为 `web`；DSH 源码安装可通过 `--dsh-cli` 指定相对 CLI 入口。安装器验证受支持的 DSH 版本，仅在需要时应用最小会话事件兼容补丁，然后通过 `dsh plugin --profile web add` 安装归档。已有冲突的 session 补丁需要显式合并，不会被覆盖。启动 DSH 前，将 `MCP_PROXY_ORIGIN` 设置为部署的公开 HTTPS 地址，继续使用既有鉴权系统和 TLS 终止设施。

补丁只向固定 DSH 版本的已知事件集合增加四个 MCP 事件名，保留对未知必需事件的拒绝，不将绑定事件标记为可忽略。本项目的开发依赖补丁只作用于本仓库；发布安装器会单独检测并在需要时修补 `--dsh-root` 指定的目标 DSH 安装。

## 目录

```text
packages/mcp-proxy/       Electron GUI、本地运行时、本地 MCP 客户端及协议
packages/dsh-plugin/      统一服务端入口、适配器、Web UI 及兼容补丁
scripts/                 独立构建、测试及发布安装工具
```

内部模块是私有 workspace 包，会打入两个交付物，无需分别安装。[架构概览](docs/architecture.md)提供模块导航，详细事实分别由上方文档维护。

## 许可证

原创增补采用 [Apache-2.0](LICENSE)，改编的 DeepSeek Harness 代码保留 [MIT 声明](LICENSE-MIT-UPSTREAM)，详见[第三方声明](THIRD_PARTY_NOTICES.md)。当前不交付 macOS/Linux 桌面版本，不包含代码签名和发布操作。
