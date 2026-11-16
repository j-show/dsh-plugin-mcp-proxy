# Local MCP desktop client

Tauri owns the window, tray, single instance and restricted renderer bridge.
The bundled Node 22 supervisor starts the existing DSH profile; the MCP core,
per-DSH routing, pairing, cancellation and filesystem ownership remain in the TypeScript modules.

Use the root package scripts: `build:win:32`, `build:win:64`, `build:win`,
`build:mac:intel`, `build:mac:arm`, `build:mac`, `build:linux`.
`build:shared` compiles common code; platform aggregates reuse it once.
Installers include Node 22.23.5 and a qualified dependency closure. Windows can install missing WebView2.
Signing/notarization/publication are separate from building.

After installation, open `mcp-proxy` and add downstream MCPs. Closing hides the window;
tray Exit stops owned resources. Command-line operations remain `--config`, `--start`,
`--stop`, `--associate`, `--install`, `--uninstall`, `--help`.
`DSH_HOME` selects a custom profile home; URI registration never replaces unknown owners.

Default data is under `%LOCALAPPDATA%/McpProxy/data` on Windows,
`~/Library/Application Support/McpProxy/data` on Mac and
`${XDG_DATA_HOME:-~/.local/share}/mcp-proxy/data` on Linux. User files and identity stay outside installed binaries.
The application does not install Node/Python required by a configured downstream MCP and provides no file sandbox.

See root [development](../../docs/development.md), [configuration](../../docs/configuration.md),
[migration](../../docs/migrations/tauri-2026-11-16.md) and [acceptance](../../docs/acceptance.md).
