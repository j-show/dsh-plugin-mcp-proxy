# dsh-plugin-mcp-proxy

- Local desktop sources belong under packages/mcp-proxy; DSH adapters belong under packages/dsh-plugin. Internal modules are bundled into the two deliverables, not published separately.
- Never reference a consumer checkout, copy credentials, or commit generated runtimes. Depend on public versioned DSH packages.
- Preserve upstream license notices. Update README and focused tests with changes.
- Do not create branches or publish releases without user instruction.
- Start from docs/requirements.md (stable B/M IDs), docs/design.md, docs/configuration.md and docs/acceptance.md. Preserve docs/history as imported evidence; it contains superseded names and paths, not current integration instructions.
- Update affected documentation and acceptance evidence with behavior changes. Distinguish implementation, automated tests and product acceptance; never close unverified scenarios based on test counts or historical manual results.
- Follow docs/development.md and CONTRIBUTING.md for reproducible setup. Development state belongs under .artifacts/dev; never reuse personal DSH homes, disable TLS/authentication, or take over an existing machine service or URI owner. Preserve settings and identities on repeated initialization.
- After native release builds use pnpm test:product for exact-build artifact acceptance and cleanup checks. This covers the five existing native cases, not the complete browser/model/multi-device product matrix.
- Browser/desktop acceptance uses pnpm test:browser with a real interactive Windows desktop. Never suppress protocol/TLS prompts, inject tray events, replace unknown URI owners or operate personal browser profiles. Keep full matrix results distinct from preflight and other product acceptance.
- Cold startup investigation uses pnpm test:browser --startup-only; keep new DSH installations/caches and browser processes/profiles distinct from page reloads. This entrypoint must not register URI handlers or control the desktop product.
