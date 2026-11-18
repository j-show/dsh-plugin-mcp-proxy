/** CLI for isolated native development; all processes use this checkout's public dependencies. */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { parseArgs, promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import {assertDevelopmentServiceIdle} from './development-service.ts'
import {nativePrerequisites} from './native-preflight.ts'
import { buildLibraries } from './build-libraries.ts'
import { relaunchBuildRuntime } from './mcp-build-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'
import { buildApplications } from './build-app.ts'
import { buildShared } from './build-shared.ts'
import { developmentPaths, initializeDevelopment, initializeDevelopmentProfiles, developmentIssues, developmentDshCli, DEVELOPMENT_ORIGIN } from './development.ts'
import { createDevelopmentProxy } from './development-proxy.ts'

const root = resolve(import.meta.dirname, '..')
const { values, positionals } = parseArgs({ allowPositionals: true, options: { packaging: { type: 'boolean' }, inspect: { type: 'boolean' }, 'skip-build': { type: 'boolean' }, uri: { type: 'string' } } })
const command = positionals[0]
if (positionals.length !== 1 || !['doctor', 'init', 'build', 'server', 'runtime', 'desktop', 'associate', 'check'].includes(command ?? '')) throw new Error('Use a documented dev:* command')
const p = developmentPaths(root)
const signalPreload = pathToFileURL(join(root, 'scripts/development-signals.mjs')).href
const execute = promisify(execFile)
async function available(command: string, args: string[]): Promise<boolean> {
  try { await execute(command, args, { windowsHide: true, timeout: 15000 }); return true } catch { return false }
}
async function fileExists(path: string): Promise<boolean> { try { await access(path); return true } catch { return false } }

async function doctor(): Promise<void> {
  const require = createRequire(import.meta.url)
  const pnpm = process.env.npm_execpath
  const version = pnpm ? (await execute(process.execPath, [pnpm, '--version'], { timeout: 15000, windowsHide: true })).stdout.trim() : ''
  const issues = developmentIssues({ node: process.version, pnpm: version,
    tar: await available('tar', ['--version']), compiler: await fileExists(join(process.env.WINDIR ?? '', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'))
      || await fileExists(join(process.env.WINDIR ?? '', 'Microsoft.NET/Framework/v4.0.30319/csc.exe')) }, values.packaging ?? false)
  if (!['win32','darwin','linux'].includes(process.platform)) issues.push('Native development requires Windows, macOS or Linux.')
  const native=values.packaging?await nativePrerequisites(process.platform):[]
  issues.push(...native.filter(check=>!check.ready).map(check=>`${check.name}: ${check.hint}`))
  for (const name of ['tsx', 'typescript', 'vitest', '@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot']) {
    try { require.resolve(name + '/package.json') } catch { issues.push(`Run pnpm install --frozen-lockfile (missing ${name}).`) }
  }
  try {
    const session = await import('@deepseek-ai/dsh-session')
    if (!['input', 'turn', 'sampling', 'elicitation'].every(name => session.KNOWN_SESSION_EVENT_TYPES.has(`mcp-proxy/${name}`))) issues.push('Session patch missing; reinstall with the repository lockfile.')
  } catch { issues.push('Cannot inspect Session patch; run pnpm install --frozen-lockfile.') }
  await mkdir(join(root,'.artifacts/ci'),{recursive:true})
  await writeFile(join(root,'.artifacts/ci',values.packaging?'doctor-native.json':'doctor-core.json'),JSON.stringify({
    scope:values.packaging?'native prerequisites':'Node/core prerequisites',platform:process.platform,node:process.version,pnpm:version,
    checks:native,issues,status:issues.length?'failed':'passed',boundary:'Discovery only; not a build, GUI, debugger or product acceptance result.',
  },null,2)+'\n')
  if (issues.length) throw new Error(issues.join('\n'))
  process.stdout.write(`${values.packaging?'Native tool discovery':'Node/core prerequisites'} passed; build/GUI/debugger acceptance is separate. First-time downloads require network access.\n`)
}

function environment(home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_') && !name.startsWith('MCP_PROXY_') && name !== 'ELECTRON_RUN_AS_NODE'))
  return { ...inherited, DSH_HOME: home, LOCALAPPDATA: p.localAppData, MCP_PROXY_ORIGIN: DEVELOPMENT_ORIGIN,
    NODE_EXTRA_CA_CERTS: join(p.tls, 'ca.pem'), MCP_PROXY_DEVELOPMENT_ROOT: p.root }
}

/** Only stop the process started by this command; never issue a machine-wide stop to an unknown owner. */
async function foreground(executable: string, args: string[], home: string, log: string): Promise<void> {
  const output = createWriteStream(join(p.logs, log), { flags: 'a', mode: 0o600 })
  const desktop = log === 'desktop.log'
  const child = spawn(executable, args, { cwd: p.workspace, env: { ...environment(home), MCP_PROXY_INSPECT: values.inspect ? '1' : undefined }, windowsHide: !desktop, shell: false,
    stdio: desktop ? ['pipe','pipe','pipe'] : ['inherit', 'pipe', 'pipe', 'ipc'] })
  child.stdout?.pipe(output, { end: false }); child.stderr?.pipe(output, { end: false })
  child.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(log === 'server.log' ? chunk.toString().replaceAll('http://127.0.0.1:3081/', DEVELOPMENT_ORIGIN + '/') : chunk) })
  child.stderr?.pipe(process.stderr)
  const stop = () => {
    if (desktop) { child.stdin?.write('mcp-development-stop\n'); return }
    if (child.connected) child.send('mcp-development-stop', error => { if (error) process.stderr.write('Graceful shutdown request failed; inspect the owned development process.\n') })
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const [code, signal] = await once(child, 'exit') as [number | null, string | null]
    if (code !== 0 && code !== 130 && signal !== 'SIGTERM' && signal !== 'SIGINT') throw new Error(`Development child failed (${signal ?? code}); see .artifacts/dev/logs/${log}`)
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); output.end() }
}

async function run(): Promise<void> {
  if (command === 'doctor') { await doctor(); return }
  // Use the same pinned, verified runtime as release/test on affected Windows Node versions.
  if (await relaunchBuildRuntime(root)) return
  if (!['win32','darwin','linux'].includes(process.platform)) throw new Error('Native development requires Windows, macOS or Linux')
  await initializeDevelopment(root)
  await initializeDevelopmentProfiles(root, p)
  if (command === 'init') { process.stdout.write(`Development state ready: ${p.root}\n`); return }
  if (command === 'build') { await buildShared(root, true); return }
  if (command === 'check') {
    await runMcpBuildCommand(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      'scripts/development.spec.ts', 'scripts/development-proxy.spec.ts', 'scripts/development-signals.spec.ts', 'scripts/download-runtime.spec.ts', 'packages/mcp-proxy/modules/local/tests/tunnel.spec.ts',
      'packages/dsh-plugin/tests/browser/association.spec.ts', 'packages/dsh-plugin/tests/server.spec.ts'], root)
    return
  }
  if (!values['skip-build']) await buildLibraries(root, true)
  if (command === 'server') {
    const proxy = createDevelopmentProxy(await readFile(join(p.tls, 'server.pfx')), 3081)
    try {
      proxy.server.listen(3443, '127.0.0.1'); await once(proxy.server, 'listening')
      process.stdout.write(`Development TLS listener ${DEVELOPMENT_ORIGIN}; DSH readiness follows in the log.\n`)
      await foreground(process.execPath, [...(values.inspect ? ['--inspect=127.0.0.1:9230'] : []), '--import', signalPreload, '--enable-source-maps', developmentDshCli(root), '--profile', 'web',
        '--host', '127.0.0.1', '--port', '3081', '--no-open', '--trusted-host', 'localhost:3443'], p.home, 'server.log')
    } finally { await proxy.close() }
    return
  }
  if (command === 'associate') {
    if (!values.uri) throw new Error('Use dev:associate --uri <one-time-activation-URI>')
    await foreground(process.execPath, ['--import', signalPreload, developmentDshCli(root),
      '--profile', 'mcp-proxy', '--config', p.settings, '--associate', values.uri], p.localHome, 'association.log'); return
  }
  await assertDevelopmentServiceIdle()
  if (command === 'runtime') {
    await foreground(process.execPath, [...(values.inspect ? ['--inspect=127.0.0.1:9232'] : []), '--import', signalPreload, '--enable-source-maps', developmentDshCli(root),
      '--profile', 'mcp-proxy', '--config', p.settings], p.localHome, 'runtime.log'); return
  }
  const products = await buildApplications(root,'host',true,true,p.presets)
  const exe = products[0]!.executable
  await writeFile(join(p.root, 'desktop-path.txt'), exe + '\n')
  await foreground(exe, ['--config',p.settings], p.localHome, 'desktop.log')
}
void run().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Development command failed'}\n`); process.exitCode = 1 })
