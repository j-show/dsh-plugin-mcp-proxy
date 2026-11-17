# @jshow/dsh-plugin-mcp-proxy/ui

DSH connection status and form/URL elicitation UI with bounded request controllers.

Private module bundled into its parent deliverable; build and test from the repository root.
Start at [src/client/index.ts](src/client/index.ts) and [src/client/elicitation-controller.ts](src/client/elicitation-controller.ts); focused coverage starts at [tests/elicitation.client.spec.ts](tests/elicitation.client.spec.ts).
For native setup and source debugging follow the [development guide](../../../../docs/development.md).
Requirements, architecture and acceptance remain owned by the root docs.

The connection section exposes its existing phase as `data-mcp-phase` for browser
acceptance assertions. Native URI activation is still triggered only by the real UI action.
