/** Shell-free process execution shared by the MCP release builders. */
import { spawn } from 'node:child_process'

/**
 * Run a build step and fail immediately on an unsuccessful process exit.
 * @param command - Executable filename.
 * @param args - Literal argument array.
 * @param cwd - Build working directory.
 * @param environment - Child environment, defaulting to the current build process.
 * @returns When the child exits successfully.
 */
export async function runMcpBuildCommand(
  command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const child = spawn(command, [...args], { cwd, env: environment, stdio: 'inherit', shell: false, windowsHide: true })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`MCP build step failed: ${command} (${signal ?? code})`))
    })
  })
}
