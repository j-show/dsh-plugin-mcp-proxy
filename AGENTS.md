# dsh-plugin-mcp-proxy

- Local desktop sources belong under packages/mcp-proxy; DSH adapters belong under packages/dsh-plugin. Internal modules are bundled into the two deliverables, not published separately.
- Never reference a consumer checkout, copy credentials, or commit generated runtimes. Depend on public versioned DSH packages.
- Preserve upstream license notices. Update README and focused tests with changes.
- Use Node 22.x >=22.19 and pnpm >=10. Keep shared orchestration in Node.js; PowerShell dependencies require explicit user approval.
- Do not create branches or publish releases without user instruction.
- Start from docs/requirements.md (stable B/M IDs), docs/design.md, docs/configuration.md and docs/acceptance.md. Preserve docs/history as imported evidence; it contains superseded names and paths, not current integration instructions.
- Update affected documentation and acceptance evidence with behavior changes. Distinguish implementation, automated tests and product acceptance; never close unverified scenarios based on test counts or historical manual results.
- On a new machine read docs/handoff.md, then docs/development.md. Use verify for core and verify --release for host-native acceptance; inspect --plan and actual per-step reports. Discovery is not product/debugger acceptance. Preserve .artifacts/dev identities and unknown service/URI owners; never reuse personal DSH homes or disable TLS/authentication.
- Build explicitly with build:win:32/64, build:win, build:mac:intel/arm, build:mac or build:linux. There is no top-level build; build:shared is reused once per aggregate and installers bind matching Node 22/native dependencies.
- User deferred Intel DMG validation on the failing CI host (2026-11-16). Preserve DMG and both Mac build targets; default CI omits Intel and records it as unverified. A manual mac_intel_runner input enables retry on another Mac; never infer acceptance from the skip.
- Supervisor crash recovery must preserve the original verified service identity and wait for actual owned-process exit. NSIS uninstall removes receipt-owned URI state before runtime files; never continue after an ownership/cleanup error.
- After native builds use test:product and test:installer with an explicit target. Windows has five native cases; Mac/Linux have three profile cases. Installer extraction is not system installation, and none closes the complete model/multi-device matrix.
- Browser/desktop acceptance uses pnpm test:browser with a real interactive Windows desktop. Never suppress protocol/TLS prompts, inject tray events, replace unknown URI owners or operate personal browser profiles. Keep full matrix results distinct from preflight and other product acceptance.
- Cold startup investigation uses pnpm test:browser --startup-only; keep new DSH installations/caches and browser processes/profiles distinct from page reloads. This entrypoint must not register URI handlers or control the desktop product.
