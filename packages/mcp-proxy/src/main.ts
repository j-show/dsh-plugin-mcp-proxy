/** Electron portable bootstrap; the existing dsh profile owns service execution. */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import { prepareElectronRuntime, type RuntimeFilesystem } from './runtime-cache.ts'
import { electronProfileLaunch, electronChildEnvironment } from './profile-launch.ts'
import { runDesktop } from './desktop-main.ts'
import { ensureLocalProfile } from './ensure-profile.ts'

let phase: 'initialization' | 'runtime-cache' | 'invocation-directory' | 'profile-launch' = 'initialization'

async function main(): Promise<void> {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('Windows local application data is required')
  const userData = join(process.env.LOCALAPPDATA, 'McpProxy/bootstrap')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setAppLogsPath(join(userData, 'logs'))
  app.commandLine.appendSwitch('log-file', join(userData, 'electron.log'))
  await app.whenReady()
  const raw = createRequire(join(app.getAppPath(), 'package.json'))('original-fs') as { promises: RuntimeFilesystem }
  phase = 'runtime-cache'
  const runtime = await prepareElectronRuntime(dirname(process.execPath),
    join(process.env.LOCALAPPDATA, 'McpProxy/runtimes'), raw.promises)
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  phase = 'invocation-directory'
  const cwd = process.env.MCP_PROXY_INVOKING_CWD ?? process.cwd()
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('Invalid invocation directory')
  const explicitConfig = args.includes('--config') || args.some(value => value.startsWith('--config='))
  const administrative = args.some(value => ['--help', '--stop', '--install', '--uninstall', '--associate'].includes(value))
    || (explicitConfig && args.includes('--start'))
  if (!administrative) {
    if (dirname(process.execPath).toLowerCase() !== runtime.toLowerCase()) {
      const child = spawn(join(runtime, 'mcp-proxy.exe'), args, { cwd, detached: true, windowsHide: false, stdio: 'ignore',
        env: { ...electronChildEnvironment(process.env), ELECTRON_RUN_AS_NODE: undefined,
          ELECTRON_LOG_FILE: join(userData, 'electron.log'), ELECTRON_ENABLE_LOGGING: '1' } })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
      app.exit(0)
      return
    }
    await runDesktop(runtime, args, cwd)
    return
  }
  const home = process.env.DSH_HOME ?? join(process.env.LOCALAPPDATA, 'McpProxy/data/dsh')
  await ensureLocalProfile(runtime, home)
  const launch = electronProfileLaunch(runtime, args, { ...process.env, DSH_HOME: home })
  phase = 'profile-launch'
  const child = spawn(launch.command, launch.args, { env: launch.env, cwd,
    windowsHide: true, shell: false, stdio: 'inherit',
  })
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { resolve(signal === null ? code ?? 1 : 1) })
  })
  app.exit(code)
}

void main().catch(async (error: unknown) => {
  const detail = error instanceof Error && /^(Invalid Electron runtime|Electron runtime|Unsupported Electron runtime)/.test(error.message)
    ? error.message : error instanceof Error ? error.name : 'unknown'
  const message = `mcp-proxy: ${phase} failed (${detail}).\n`
  process.stderr.write(message)
  if (process.env.LOCALAPPDATA) {
    try {
      const directory = join(process.env.LOCALAPPDATA, 'McpProxy')
      await mkdir(directory, { recursive: true })
      await appendFile(join(directory, 'bootstrap.log'), message)
    } catch (_error) { /* A denied diagnostics path cannot prevent a failing exit. */ }
  }
  app.exit(1)
})
