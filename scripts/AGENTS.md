# Build scripts

- Build only this repository and declared npm dependencies. No consumer paths or workspace fallback.
- Keep intermediates under .artifacts and delivery files under release. Validate dependency closure before publishing an EXE or plugin archive.
- Development uses public DSH CLI/profile APIs and checkout-owned state. Keep initialization idempotent, refuse unowned or linked state paths, and test trust/proxy behavior without changing certificate stores. CI evidence must name the source revision and actual command exits; do not upload development state.
- Portable NSIS packaging uses an owned temporary short-path drive alias. Never replace an existing mapping; remove only a mapping whose target still matches this build directory, including on failure.
