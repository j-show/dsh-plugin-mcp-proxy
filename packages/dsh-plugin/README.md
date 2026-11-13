# DSH server plugin

This is the single public server entry. Its private modules provide authenticated endpoint admission, per-Turn tool binding, browser association and the Web connection UI. The archive bundles them with the shared protocol, so they require no separate publication.

Build with `pnpm build:mcp-plugin` at the repository root. Use the emitted installation helper for DSH `0.1.6-alpha.2`; it verifies compatibility at the actual DSH installation, preserves existing configuration and installs through DSH's public plugin command. Stop DSH before changing dependencies. The four-event patch under `compat/` is required on an unmodified upstream installation and is skipped when already supported.

Set `MCP_PROXY_ORIGIN` to the public HTTPS origin. Forward WebSocket upgrades through the deployment's existing TLS proxy and keep its authentication enabled. The bundle's configuration groups are `host`, `agent`, `browser` and `ui`; complete examples and defaults are in the [configuration guide](../../docs/configuration.md). Removing the parent removes child routes, agents and UI discovery. The plugin does not select a model or carry deployment credentials.

Agent delivery guidance directs user-facing files to downstream local MCPs and permits remote temporary processing files. Tool results retain MCP metadata. A selected endpoint or service incarnation becoming unavailable fails the call rather than routing it to another machine. Pending operations are never replayed on reconnect.

Continue from the [requirements and capability limits](../../docs/requirements.md), [design](../../docs/design.md) and [acceptance record](../../docs/acceptance.md), currently maintained in Chinese. Session event compatibility does not by itself establish full history replay, SDK compatibility or restart continuation acceptance.
