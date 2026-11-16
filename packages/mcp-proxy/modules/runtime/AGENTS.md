# @j-show/mcp-proxy-runtime

- Keep this package independent of consumer checkouts; use declared public DSH dependencies.
- Preserve cancellation, per-DSH routing, TLS validation and file ownership checks.
- Update the package README and focused tests with behavior changes.
- Exercise native development via docs/development.md. Derive subprocess recovery waits from configured deadlines; retain no-replay and actual-file assertions under CI load.
- URI registration must work with Windows 8.3 aliases without relaxing owner or exact-command checks. Retain native short-path upgrade/uninstall regressions; skip only the alias-specific variant when the test volume has no 8.3 aliases.
- Keep app-data launch context in trusted receipt metadata, never in browser activation parameters. Production uses Tauri and Node 22; retain legacy receipt parsing/tests only for safe existing-launcher removal and upgrade.
- Normalize the full executable path before locating activation diagnostics; short aliases must retain the same fixed-name, URI-free trace.
- Use direct native probes rather than PowerShell. Size Job structures for the executing Node architecture; preserve each install/uninstall deadline and all ownership, recovery and cleanup assertions.
- Native profile fixtures must create identity files at mode 0600; keep DSH's POSIX credential permission checks enabled.
- Background group EPERM is unknown, never proof of exit. Reconcile only within the original cleanup budget, require authoritative absence and direct-child join, never signal unknown scopes or retry a denied signal. Preserve process-exit assertions before bounded fixture-directory deletion retries.
