# Windows MCP connector

For isolated native source debugging use the [development guide](../../docs/development.md).
`pnpm dev:desktop --inspect` builds a development distribution with source maps,
project-owned state and no automatic URI registration; release builds retain the portable entry.

Release builds emit `release/mcp-proxy/product-build.json` to bind the portable EXE
to its qualified unpacked runtime. Use `pnpm test:product` for native artifact acceptance;
the manifest verification is read-only and rejects changed files before execution.

This package owns the Electron GUI and tray. Its private `modules/protocol`, `modules/local` and `modules/runtime` packages own wire exchange, downstream clients and the standalone DSH profile. Build from the repository root with `pnpm build:mcp-proxy`; deliver `release/mcp-proxy/mcp-proxy.exe` only.

See the detailed [configuration and operations](../../docs/configuration.md), [capability limits](../../docs/requirements.md#能力范围) and [acceptance record](../../docs/acceptance.md). These current guides are in Chinese. File operations belong to configured downstream MCPs; this application has no built-in file tools.

Open the EXE to create an empty configuration and start the local service. Defaults live under `%LOCALAPPDATA%/McpProxy/`; user configuration, identities, logs and verified runtime caches are separate. The default working directory is `Documents/mcp-proxy-workspace`. Downstream MCP commands retain their own runtime prerequisites.

Add stdio MCPs by command, one argument per line, and optional working directory/environment; or add Streamable HTTP/SSE endpoints with optional headers. Deleting an MCP immediately cancels affected calls from all DSH connections. Each DSH Web activation connects automatically. Manually disconnected origins stay disabled until a fresh activation; delayed requests cannot re-enable them.

Closing the GUI hides it to the tray. Tray click reopens it; the menu lists DSH connection states and exits without confirmation. URI registration refuses an unrelated owner rather than overwriting it. TLS validation stays enabled. Deployment-specific builds can embed public per-origin CA presets with `--connection-presets`; activation URIs cannot supply trust material.

See the root README for build prerequisites and optional explicit build inputs. Runtime dependency licenses remain included in the executable payload.

The portable and URI launchers initialize Electron logging under application state before Chromium starts. Program inventories remain strict; an unexpected `debug.log` inside a runtime is an error, not an exempt file.
