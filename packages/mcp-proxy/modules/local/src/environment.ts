/** Local process environment after removing runtime-owned credential references. */
import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio'
import { DEFAULT_INHERITED_ENV_VARS as LEGACY_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/**
 * Resolve one inherited environment snapshot before any MCP process starts.
 * @param excluded - credential reference names which must not be inherited implicitly.
 * @returns scrubbed environment; explicit per-service env is applied by the driver afterward.
 */
export function localProcessEnvironment(excluded: readonly string[]): Record<string, string> {
  const blocked = new Set([...excluded, 'ELECTRON_RUN_AS_NODE', 'ELECTRON_LOG_FILE',
    'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_SERVER_URL'].map(name => name.toUpperCase()))
  if ([...DEFAULT_INHERITED_ENV_VARS, ...LEGACY_INHERITED_ENV_VARS].some(name => blocked.has(name.toUpperCase()))) {
    throw new Error('MCP proxy credential reference conflicts with an SDK-inherited operating-system variable')
  }
  return Object.fromEntries(Object.entries(scrubbedParentEnv()).filter(([name]) => !blocked.has(name.toUpperCase())))
}
