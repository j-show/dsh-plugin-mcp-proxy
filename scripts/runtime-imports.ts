/** Built-library import smoke for the independent local MCP distribution. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Import each public local-application entry without starting an agent or MCP.
 * @param directory - deployed dependency resolver root.
 * @param executable - qualified bundled Node executable.
 * @param environment - child runtime environment.
 * @returns after all application entries and their dependencies import successfully.
 */
export async function verifyMcpRuntimeImports(directory: string, executable: string,
  environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const source = "for (const name of ['@j-show/mcp-proxy-runtime', '@j-show/mcp-proxy-runtime/startup',"
    + " '@j-show/mcp-proxy-runtime/desktop']) await import(name)"
  await promisify(execFile)(executable, ['--input-type=module', '--eval', source],
    { cwd: directory, env: environment, windowsHide: true, timeout: 30000, maxBuffer: 1048576 })
}
