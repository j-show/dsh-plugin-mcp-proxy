/** Fixed upstream compatibility policy for this release. */
export const SUPPORTED_DSH_VERSION = '0.1.6-alpha.2'
/** Required Session vocabulary preserved by the versioned compatibility patch. */
export const MCP_SESSION_EVENTS = ['mcp-proxy/input', 'mcp-proxy/turn', 'mcp-proxy/sampling', 'mcp-proxy/elicitation'] as const

/** @param patches - Existing pnpm patch configuration. @throws When any session patch would be superseded. */
export function assertNoSessionPatchOverlap(patches: Readonly<Record<string, unknown>>): void {
  if (Object.keys(patches).some(key => key === '@deepseek-ai/dsh-session' || key.startsWith('@deepseek-ai/dsh-session@'))) {
    throw new Error('An existing DSH session patch must be merged explicitly before installation')
  }
}
