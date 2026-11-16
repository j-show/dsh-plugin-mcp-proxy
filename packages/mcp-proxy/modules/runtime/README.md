# @j-show/mcp-proxy-runtime

Private implementation module bundled into the parent MCP connector or DSH plugin. It is built and tested from the repository root and is not installed or published separately. See the parent package README for configuration.

Use `pnpm dev:runtime --inspect` for the isolated native profile described in
[development](../../../../docs/development.md). Recovery tests retain the unknown/no-replay
contract and wait within the configured startup/reconnect budget, including MCP shutdown.

Windows URI registration expands the trusted current and predecessor executable paths
from 8.3 aliases before checking registry commands. Native regressions cover short-path
upgrade/uninstall and still reject another owner or an unrelated registered command.
The predecessor name is combined with the normalized current directory, so recovery
also works after predecessor deletion but before its receipt update was committed.
URI receipts may include an absolute `localAppData` path; the native launcher carries
it into child startup, while older receipts retain the inherited Windows environment.
Activation diagnostics use the canonical helper name even when Windows launches its
8.3 alias, retaining only fixed stage names and never URI contents.
The multi-step native upgrade regression has a 90-second aggregate budget;
direct native probes preserve individual 5-second install/uninstall deadlines.
Native profile acceptance creates owner-only identity files (`0600`), matching
the real DSH credential provider on macOS and Linux.
Background cancellation treats `EPERM` as unknown presence, retaining custody within
the cleanup deadline until authoritative absence and the direct-child join agree.
Unknown scopes are not signalled; a denied signal is not retried. Persistent uncertainty fails.
Product fixtures retry transient directory locks only after service/MCP exit assertions pass.
