# @j-show/mcp-proxy-runtime

- Keep this package independent of consumer checkouts; use declared public DSH dependencies.
- Preserve cancellation, per-DSH routing, TLS validation and file ownership checks.
- Update the package README and focused tests with behavior changes.
- Exercise native development via docs/development.md. Derive subprocess recovery waits from configured deadlines; retain no-replay and actual-file assertions under CI load.
- URI registration must work with Windows 8.3 aliases without relaxing owner or exact-command checks. Retain native short-path upgrade/uninstall regressions; skip only the alias-specific variant when the test volume has no 8.3 aliases.
- Keep app-data launch context in trusted receipt metadata, never in browser activation parameters; test both Node and Electron launcher modes.
- Normalize the full executable path before locating activation diagnostics; short aliases must retain the same fixed-name, URI-free trace.
- Bound PowerShell probes explicitly and size multi-step native test budgets for compilation and all transactions. Preserve each install/uninstall operation deadline and all ownership, recovery and cleanup assertions.
