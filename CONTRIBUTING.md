# Contributing

Start with [requirements](docs/requirements.md), [design](docs/design.md) and the
[Windows development guide](docs/development.md). Use the fixed public DSH version;
do not reference another checkout or copy personal profiles, credentials or caches.

1. Prepare the documented Node, pnpm and Windows tools, then install with
   `pnpm install --frozen-lockfile`.
2. Use `pnpm dev:doctor`, `pnpm dev:init` and the development guide to reproduce the
   issue in a project-owned environment. A real model key is optional for unit and
   protocol tests, and required only for real-model exercises.
3. Identify the affected B/M requirement and acceptance scenario. Add a failing
   regression before changing behavior; preserve cancellation, routing, TLS and
   resource ownership. New product scope needs explicit requirements.
4. Run `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm dev:check`. For packaging
   changes also run `pnpm dev:doctor --packaging` and the affected release build.
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
