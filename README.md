# DSH MCP Proxy

English | [中文](README.zh.md)

A Windows desktop connector for local MCP servers and a separately installable DSH server plugin. The desktop application connects to multiple DSH services, shares one local MCP list, and routes every call and callback to its originating DSH connection. It adds no file tools: configured downstream MCP servers perform local operations.

## Requirements and continued development

| Document | Contents |
| --- | --- |
| [Current requirements](docs/requirements.md) | Confirmed B1–B28, extraction requirements, supported MCP capabilities and exclusions |
| [Current design](docs/design.md) | Pairing, per-Turn and per-origin ownership, cancellation, callbacks and recovery |
| [Configuration and operations](docs/configuration.md) | Installation, complete examples, limits, disable/remove and diagnostics |
| [Acceptance and remaining work](docs/acceptance.md) | Requirement coverage, recorded evidence, reproduction and outstanding implementation/validation |
| [Complete historical baseline](docs/history/README.md) | Original confirmed requirements and Plan A in both languages, later decisions and import hashes |

The current detailed guides are maintained in Chinese; the historical baseline includes both languages. Start continued development from a requirement ID and acceptance item without another checkout or chat history. Implemented behavior, automated coverage and product acceptance are separate: full joint acceptance remains outstanding. MCP support is limited to the documented transports and capabilities; resources/prompts are excluded.

## Develop

Follow the [Windows development and debugging guide](docs/development.md) for a new
machine, isolated DSH profiles, local TLS and source breakpoints. See
[CONTRIBUTING](CONTRIBUTING.md) and [security reporting](SECURITY.md).
After installing dependencies, run `pnpm dev:doctor` and `pnpm dev:init`;
`pnpm dev:server` and `pnpm dev:desktop` start the native development environment.
Windows CI checks clean installs, tests and both deliverables without production secrets.

After `pnpm build:mcp-proxy`, run `pnpm test:product` on a Windows machine with an
unused local service slot. It binds the recorded build's EXE/runtime pair, requires
all five native product cases to pass, and verifies service/data cleanup. Release CI
runs this automatically after both builds; see the [acceptance guide](docs/acceptance.md).

Use Node.js 22.19+ or 24+ and pnpm 11.7.0. Dependencies come from the public npm registry; no Harness checkout is required.

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

On affected Windows Node 24 versions, release builds and tests automatically prepare a checksum-pinned private Node runtime under `.artifacts/`. They do not change the global Node installation. First use requires network access.

## Build releases

```sh
pnpm build:mcp-proxy
pnpm build:mcp-plugin
```

The first command requires Windows x64 and produces `release/mcp-proxy/mcp-proxy.exe`, including Electron and all runtime dependencies. The second produces `release/mcp-plugin/`, containing one installable plugin tarball, `install.mjs`, release metadata and the compatibility patch. Intermediates remain under `.artifacts/`. `--skip-build` reuses compiled libraries. The EXE builder also accepts `--electron-dist`, `--node-license` and `--connection-presets` for explicit build inputs.

Builds also emit a small Node-profile runtime archive under `release/mcp-proxy/` for artifact-only consumer integration tests. It is not another Windows end-user installation step. Product tests are opt-in with `MCP_PROXY_PRODUCT_TESTS=1` and require an unused machine service slot; their source lists the qualified Electron artifact inputs.

## Install and use

Open `mcp-proxy.exe` on the computer running the downstream MCPs. It starts its service and registers `mcp-proxy://` automatically. Add MCP commands or HTTP/SSE endpoints in its GUI. From each DSH Web page, select “Connect this computer”. The connector automatically accepts a valid activation; the GUI allows per-DSH disconnection. Closing its window hides it to the tray. Tray Exit stops the owned service without another confirmation.

The plugin targets DSH `0.1.6-alpha.2`. Stop the server and run the release installer against the **DSH package-manager installation root**, not its profile directory:

```sh
node release/mcp-plugin/install.mjs --dsh-root <dsh-installation-root>
```

Set `DSH_HOME` when using a custom profile home. `--profile` defaults to `web`; `--dsh-cli` selects a relative CLI entry for a DSH source installation. The installer verifies the supported DSH version, applies the minimum session-event compatibility patch only when needed, then uses `dsh plugin --profile web add` to install the archive. An existing conflicting session patch requires an explicit merge; it is never overwritten. Set `MCP_PROXY_ORIGIN` to the deployment's public HTTPS origin before starting DSH. Keep the existing authentication system and TLS termination.

The patch adds only the four MCP event names to the fixed DSH version's known-event set. It preserves refusal of unknown required events and does not mark binding events ignorable. Applying the patch to this repository's development dependencies alone does not patch a separately installed DSH server.

## Layout

```text
packages/mcp-proxy/       Electron GUI, local runtime, local MCP clients and protocol
packages/dsh-plugin/      Unified server entry, adapters, browser UI and compatibility patch
scripts/                 Independent build, test and release installation tools
```

Internal modules are private workspace packages bundled into the two deliverables; they are not separate installation steps. The [architecture overview](docs/architecture.md) links to the detailed guides above.

## License

Original additions use [Apache-2.0](LICENSE). Adapted DeepSeek Harness code retains its [MIT notice](LICENSE-MIT-UPSTREAM); see [third-party notices](THIRD_PARTY_NOTICES.md). macOS/Linux desktop distributions, code signing and publication are outside the current delivery.
