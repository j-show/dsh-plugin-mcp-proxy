# @j-show/mcp-proxy-runtime

- Keep this package independent of consumer checkouts; use declared public DSH dependencies.
- Preserve cancellation, per-DSH routing, TLS validation and file ownership checks.
- Update the package README and focused tests with behavior changes.
- Exercise native development via docs/development.md. Derive subprocess recovery waits from configured deadlines; retain no-replay and actual-file assertions under CI load.
