# Build scripts

- Build only this repository and declared public npm dependencies. Internal modules stay bundled in the two deliverables.
- Keep intermediates under .artifacts and deliveries under release. Validate dependency closure before producing an EXE or plugin archive.
- Development initialization preserves existing settings/identities and refuses unowned or linked paths. Unit trust/proxy checks leave certificate stores unchanged; browser acceptance uses the temporary CA ownership contract below.
- Portable NSIS builds may use an owned short-path drive alias. Remove only a mapping still pointing to this build directory, including after failure.
- Native product acceptance reads the successful build receipt, verifies EXE/runtime hashes and inventory, refuses occupied service slots and requires all five cases with zero skips.
- Before changing browser-*.ts, test-browser.ts or native/BrowserDesktopProbe.cs, read [browser acceptance implementation constraints](../docs/development.md#浏览器验收实现约束). It owns the UIA lookup, input gates, tray scope, negative fixtures, screenshot and cleanup rules.
- Browser acceptance uses real headed Chrome/Edge and ownership-fenced UIA/Win32 actions. Require active matching desktops, an unoccupied merged URI registration and a free service slot; preserve unknown owners.
- Keep both seven-scenario matrices and both native safety guards mandatory. Verify exact-build artifact binding and each browser's URI/CA/process/service cleanup; preflight or skipped scenarios cannot satisfy acceptance.
- Dispatch native consent once after verified focus/foreground/geometry and the protection interval. Retry only proven pre-input refusals; uncertain input disables further tray UI cleanup and uses the existing owned process/service recovery.
- Retain only sanitized diagnostics and scoped screenshots. Profiles, identity files, private keys, authentication URLs/headers and raw server logs remain private.
- CI evidence names the actual commit, dirty state, executed command exits and artifact hashes. Record observed framework resolution anchors/module revisions; distinguish implementation, automated coverage and the remaining product matrix.
- Cold startup requires three independently installed DSH environments and three fresh browser processes/profiles each, per browser. Require owned process exit and CA/private-state cleanup; startup-only leaves URI and machine services untouched. Page observations separately require a new document epoch. Stop on the first failure and preserve sanitized exit/activation diagnostics; successful boots alone do not establish a historical root cause.
- Before cold-page input, focus the unique visible Chromium window of the creation-fenced process and require a visible/focused page. Foreground refusal is an environment failure; do not bypass it or infer client activation failure from ignored clicks.
