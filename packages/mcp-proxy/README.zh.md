# Windows MCP 连通应用

原生源码调试见[开发指南](../../docs/development.md)。`pnpm dev:desktop --inspect`
生成带 sourcemap 的开发分发，使用项目专用状态，不自动注册 URI；发布构建继续采用便携入口。

本包拥有 Electron GUI 与托盘。内部私有模块 `modules/protocol`、`modules/local`、`modules/runtime` 分别负责协议交换、下游客户端及独立 DSH profile。在仓库根目录运行 `pnpm build:mcp-proxy`，仅交付 `release/mcp-proxy/mcp-proxy.exe`。

完整[配置示例与维护操作](../../docs/configuration.md)、[能力边界](../../docs/requirements.md#能力范围)和[产品验收记录](../../docs/acceptance.md)由根文档维护。下游 MCP 执行文件操作；本应用不自带文件工具。

打开 EXE 即创建空配置并启动本地服务。默认数据位于 `%LOCALAPPDATA%/McpProxy/`，配置、身份、日志与经过校验的运行缓存分开保存；默认工作目录为 `Documents/mcp-proxy-workspace`。下游 MCP 命令保留各自的运行环境要求。

stdio MCP 可配置命令、逐行参数及可选工作目录和环境变量，也可添加带可选 headers 的 Streamable HTTP/SSE 地址。删除 MCP 会立即取消所有 DSH 上受影响的调用。各 DSH 网页激活后自动连接；手动断开的地址保持禁用，直到收到新的激活，更早的迟到请求不能重新启用。

关闭 GUI 后缩小到托盘，点击图标重新显示；菜单列出 DSH 状态并可直接退出。URI 注册遇到无关所有者会拒绝覆盖。TLS 校验始终启用，部署专用构建可用 `--connection-presets` 内置逐地址的公开 CA；激活 URI 不能提供信任材料。

构建前提与可选输入见根 README，运行依赖的许可证保留在 EXE 载荷中。

便携启动器和 URI 启动器会在 Chromium 启动前，将 Electron 日志初始化到应用状态目录。程序文件清单继续严格校验，运行目录中意外出现的 `debug.log` 属于错误，不会被豁免。
