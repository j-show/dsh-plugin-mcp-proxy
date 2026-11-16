# @j-show/mcp-proxy

- Keep this package independent of consumer checkouts; use declared public DSH dependencies.
- Preserve cancellation, per-DSH routing, TLS validation and file ownership checks.
- Update the package README and focused tests with behavior changes.
- Keep repository-root docs/requirements.md, docs/design.md and docs/acceptance.md current. Do not infer cross-login singleton acceptance from same-user tests.
- Tauri owns windows, tray and the narrow IPC bridge. The bundled Node 22 supervisor owns the existing DSH profile; do not reimplement routing or MCP semantics in the renderer or Rust shell.
- Establish supervisor containment before its first start RPC. Recovery uses only the verified owner event, never a rejected or replacement snapshot; keep adopted external services separate from the kernel-owned process scope.
- Verify the embedded runtime inventory before starting Node, including administrative CLI launches. Node process arguments use ordinary Windows paths, not verbatim UNC prefixes.
- Debug builds use explicit checkout state and source maps without automatic URI registration. Development must still obey the machine singleton.
- Preserve read-only runtime qualification for native product tests; artifact acceptance must not silently repair or republish a damaged runtime.
- Preserve the registered desktop's LOCALAPPDATA on URI activation. Browser E2E must click real native controls, validate both GUI pages, and retain process creation identity fences during cleanup.
