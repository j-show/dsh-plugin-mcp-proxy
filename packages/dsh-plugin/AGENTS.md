# @jshow/dsh-plugin-mcp-proxy

- Keep this package independent of consumer checkouts; use declared public DSH dependencies.
- Preserve cancellation, per-DSH routing, TLS validation and file ownership checks.
- Update the package README and focused tests with behavior changes.
- Follow repository-root docs/requirements.md and docs/design.md. Record persistence, SDK and product-validation gaps in docs/acceptance.md; known event names alone do not establish complete history recovery.
- Keep host/agent/browser/ui as ordinary source directories with relative imports and direct Cordis plugin composition. Preserve dependency startup order, joined disposal and rollback on activation failure; only server and browser entries are built.
- Browser E2E may observe connection phase attributes but must not call controllers or fabricate pairing state in place of real user gestures and the OS handler.
