/** Shell-free process execution shared by the MCP release builders. */
import { spawn } from 'node:child_process'
import {win32} from 'node:path'

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
  if(command==='tar')command=nativeTar(process.platform,environment)
  const child = spawn(command, [...args], { cwd, env: environment, stdio: 'inherit', shell: false, windowsHide: true })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`MCP build step failed: ${command} (${signal ?? code})`))
    })
  })
}

/** Windows builds must not inherit MSYS tar's drive-letter-as-remote interpretation. */
export function nativeTar(platform: NodeJS.Platform=process.platform,environment:NodeJS.ProcessEnv=process.env,architecture:NodeJS.Architecture=process.arch):string {
  if(platform!=='win32')return 'tar'
  const root=Object.entries(environment).find(([key])=>key.toLowerCase()==='systemroot')?.[1]
    ??Object.entries(environment).find(([key])=>key.toLowerCase()==='windir')?.[1]
  if(!root||!win32.isAbsolute(root))throw new Error('Windows system directory is required for native tar')
  return win32.join(root,architecture==='ia32'&&environment.PROCESSOR_ARCHITEW6432?'Sysnative':'System32','tar.exe')
}

/** Resolve shell-free child-process invocations for the pnpm process that launched a package script. */

/**
 * Resolve pnpm's executable and arguments from its lifecycle environment.
 * @param args - Arguments to pass to pnpm.
 * @param environment - Lifecycle environment containing `npm_execpath`.
 * @returns A command and argument array suitable for `spawn` or `spawnSync` without a shell.
 */
export function pnpmInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const entrypoint = environment.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('pnpm invocation: npm_execpath is unavailable; invoke the script through pnpm run.')
  }
  if (/\.[cm]?js$/iu.test(entrypoint)) {
    return { command: process.execPath, args: [entrypoint, ...args] }
  }
  return { command: entrypoint, args: [...args] }
}
