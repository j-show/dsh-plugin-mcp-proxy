# @jshow/app-mcp-proxy

- Keep this package independent of consumer checkouts; use declared public DSH dependencies.
- Preserve cancellation, per-DSH routing, TLS validation and file ownership checks.
- Update the package README and focused tests with behavior changes.
- Keep repository-root docs/requirements.md, docs/design.md and docs/acceptance.md current. Do not infer cross-login singleton acceptance from same-user tests.
- Tauri owns windows, tray and the narrow IPC bridge. The bundled Node 22 supervisor owns the existing DSH profile; do not reimplement routing or MCP semantics in the renderer or Rust shell.
- Establish supervisor containment before its first start RPC. Recovery uses only the verified owner event, never a rejected or replacement snapshot; keep adopted external services separate from the kernel-owned process scope.
- Rust group draining also treats Unix EPERM as unknown within the fixed grace/reap budget. Only authoritative absence completes cleanup; persist uncertainty across exit retries and never signal an unanchored group after uncertainty, including Drop.
- An adopted process probe proves exit only on ESRCH. Permission/inspection errors keep shutdown failed and retryable; never treat them as successful cleanup.
- Verify the embedded runtime inventory before starting Node, including administrative CLI launches. Node process arguments use ordinary Windows paths, not verbatim UNC prefixes.
- frontendDist must resolve to an embedded Directory; use project-relative paths so Windows drive letters cannot become URLs. Never allow file origins to work around a blank GUI. Debug navigation diagnostics contain fixed classifications only.
- Debug builds use explicit checkout state and source maps without automatic URI registration. Development must still obey the machine singleton.
- Preserve read-only runtime qualification for native product tests; artifact acceptance must not silently repair or republish a damaged runtime.
- Preserve the registered desktop's LOCALAPPDATA on URI activation. Browser E2E must click real native controls, validate both GUI pages, and retain process creation identity fences during cleanup.
