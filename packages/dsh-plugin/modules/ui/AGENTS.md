# @jshow/dsh-plugin-mcp-proxy/ui

- Keep this package independent of consumer checkouts; use declared public DSH dependencies.
- Preserve cancellation, per-DSH routing, TLS validation and file ownership checks.
- Update the package README and focused tests with behavior changes.
- Browser E2E may observe connection phase attributes but must not call controllers or fabricate pairing state in place of real user gestures and the OS handler.
