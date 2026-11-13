# @j-show/mcp-proxy-runtime

Private implementation module bundled into the parent MCP connector or DSH plugin. It is built and tested from the repository root and is not installed or published separately. See the parent package README for configuration.

Use `pnpm dev:runtime --inspect` for the isolated native profile described in
[development](../../../../docs/development.md). Recovery tests retain the unknown/no-replay
contract and wait within the configured startup/reconnect budget, including MCP shutdown.
