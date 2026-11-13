# @j-show/mcp-proxy

- Keep this package independent of consumer checkouts; use declared public DSH dependencies.
- Preserve cancellation, per-DSH routing, TLS validation and file ownership checks.
- Update the package README and focused tests with behavior changes.
- Keep repository-root docs/requirements.md, docs/design.md and docs/acceptance.md current. Do not infer cross-login singleton acceptance from same-user tests.
- Set both Electron logging variables before portable and URI launches, keeping Chromium diagnostics under application state. Never exempt diagnostics from immutable runtime inventory checks.
- The development-only entry uses explicit checkout state and source maps without portable cache publication or automatic URI registration. Keep production defaults unchanged; development must still obey the machine singleton.
- Preserve read-only runtime qualification for native product tests; artifact acceptance must not silently repair or republish a damaged runtime.
- Preserve the registered desktop's LOCALAPPDATA on URI activation. Browser E2E must click real native controls, validate both GUI pages, and retain process creation identity fences during cleanup.
