# Build scripts

- Build only this repository and declared npm dependencies. No consumer paths or workspace fallback.
- Keep intermediates under .artifacts and delivery files under release. Validate dependency closure before publishing an EXE or plugin archive.
- Development uses public DSH CLI/profile APIs and checkout-owned state. Keep initialization idempotent, refuse unowned or linked state paths, and test trust/proxy behavior without changing certificate stores. CI evidence must name the source revision and actual command exits; do not upload development state.
- Portable NSIS packaging uses an owned temporary short-path drive alias. Never replace an existing mapping; remove only a mapping whose target still matches this build directory, including on failure.
- Native product acceptance must read the successful build receipt, verify EXE and runtime hashes/inventory, refuse occupied service slots and require all five cases with zero skips. Never choose artifacts by directory timestamps, stop unknown owners, or upload private product-test state.
- Browser E2E must use real headed Chrome/Edge and ownership-fenced native UIA/Win32 actions. Refuse missing interactive desktops or existing URI owners. Remove only newly imported CA fingerprints and this run's registrations/processes; do not upload profiles, private keys or bootstrap tokens.
- Certificate warnings may be confirmed only in the captured test helper process/creation identity with its expected image and test CA text. Use native control patterns or verified pointer hit targets; never click an arbitrary Yes button or an occluding window.
- MCP startup markers may include exited version-negotiation children. Track only creation-fenced live descendants of the owned service; reject live unowned markers and compare stable live identities across second launch.
- Fresh DSH onboarding must be handled through its real nonbinding Continue and Configure later controls. Verify pointer hit targets before browser clicks so a modal cannot redirect a background action.
- Failure routing diagnostics must contain only fixed activation stages, whitelisted paths without queries and numeric response codes. Never publish raw URI, headers or server output.
- Protocol consent uses real keyboard input after verifying the exact button's keyboard focus and owning foreground window, then requires prompt dismissal and handler execution evidence. Never send blind keys or replace consent with an injected callback.
- Retry only confirmed pre-input failures. Partial input must release any pressed key and fail without replay; helper timeout or missing native diagnostics is also uncertain.
- Preserve the last fixed native control failure across confirmation retries; a generic retry deadline must not hide the refused action.
- Focus protocol controls by their verified owning root window, never by top-level enumeration order. Require the input and process desktops to match; hit diagnostics may include only PID/type/class, never element Name/Title.
- A control's center is not guaranteed clickable. Try the provider point and interior candidates but require the same target/subtree hit. Capture protocol windows only under the existing page token checks and verified process/root ownership.
