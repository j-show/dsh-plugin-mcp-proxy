# Contributing

Start with [requirements](docs/requirements.md), [design](docs/design.md) and the
[cross-platform development guide](docs/development.md). Use the fixed public DSH version;
do not reference another checkout or copy personal profiles, credentials or caches.

1. Follow [handoff](docs/handoff.md) to prepare Node/pnpm and the chosen host's tools, then install with
   `pnpm install --frozen-lockfile`.
2. Use `pnpm dev:doctor`, `pnpm dev:init` and the development guide to reproduce the
   issue in a project-owned environment. A real model key is optional for unit and
   protocol tests, and required only for real-model exercises.
3. Identify the affected B/M requirement and acceptance scenario. Add a failing
   regression before changing behavior; preserve cancellation, routing, TLS and
   resource ownership. New product scope needs explicit requirements.
4. Run `pnpm verify` for core checks. Native changes also require `pnpm dev:doctor --packaging`
   and `pnpm verify --release` (preview with `--plan`, choose an affected `--target` as needed).
   Local and CI use the same plan, including Rust, exact-build product/installer checks and Windows browser E2E.
   Native cases require zero skips and a free service slot; Intel DMG remains explicitly deferred.
5. Update affected README/AGENTS and current design/configuration/acceptance docs.
   Keep docs/history unchanged. Describe behavior, verification and remaining
   product acceptance in the PR. Do not mark skipped tests as passing.

CI runs without production accounts and does not publish releases. Use Issues for
reproducible defects or proposals and PRs for reviewable changes. Include OS/tool
versions, commit, command, exit status and sanitized diagnostics. Never attach raw
profiles, keys, cookies, activation tickets, model requests or personal files.
Follow [SECURITY.md](SECURITY.md) for sensitive reports.

Generated dependencies, `.artifacts/`, `release/`, local configuration and private
certificates are not source. Before submitting, inspect both the Git diff and new
files. A working local tree is not available to other contributors until it has
been committed and pushed through the repository's normal review process.
