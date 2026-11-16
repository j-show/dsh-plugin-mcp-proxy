# 本地 MCP 连通应用

桌面层使用 Tauri，业务核心继续使用随包 Node 22/DSH。窗口、托盘和受限 IPC 位于 Rust；
配对、调用归属、取消、TLS 与 MCP 执行保留在 TypeScript 模块。

从仓库根目录运行平台 `build:*` 脚本，共享阶段为 `build:shared`。
安装包内置 Node 22.23.5；Windows 可自动补装缺失的 WebView2，不再以单 EXE 便携应用交付。
签名、公证、正式发布另行验证。

启动应用后配置下游 MCP，再从 DSH Web 连接本机。关闭窗口仅隐藏；托盘退出等待自有资源清理。
命令保留 `--config`、`--start`、`--stop`、`--associate`、`--install`、`--uninstall`、`--help`。
`DSH_HOME` 可覆盖 profile home，URI 操作不接管未知所有者。

Windows 数据仍在 `%LOCALAPPDATA%/McpProxy/data`；Mac 为
`~/Library/Application Support/McpProxy/data`，Linux 为 `${XDG_DATA_HOME:-~/.local/share}/mcp-proxy/data`。
配置、身份和工作文件独立保存。下游 MCP 自己需要的 Node/Python/其他软件仍由用户提供，应用不提供文件沙箱。

完整说明见根目录[开发](../../docs/development.md)、[配置](../../docs/configuration.md)、
[迁移](../../docs/migrations/tauri-2026-11-16.md)与[验收](../../docs/acceptance.md)。
