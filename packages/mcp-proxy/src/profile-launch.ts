/** Launch specifications for the existing dsh profile under Electron's Node mode. */
import { join } from 'node:path'

/** @param environment - caller-owned variables. @returns a copy without another Electron instance's crash registration. */
export function electronChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment }
  delete child.CHROME_CRASHPAD_PIPE_NAME
  delete child.CHROME_CRASHPAD_SERVER_URL
  return child
}

/**
 * @param runtime - validated persistent Electron distribution.
 * @param args - user command-line arguments, forwarded without a shell.
 * @param environment - inherited deployment environment.
 * @returns executable, fixed profile arguments and Node-mode environment.
 */
export function electronProfileLaunch(runtime: string, args: readonly string[], environment: NodeJS.ProcessEnv): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  return { command: join(runtime, 'mcp-proxy.exe'),
    args: [join(runtime, 'resources/dsh/lib/bin.js'), '--profile', 'mcp-proxy', ...args],
    env: { ...electronChildEnvironment(environment), ELECTRON_RUN_AS_NODE: '1' },
  }
}
