/** CLI for isolated native development; all processes use this checkout's public dependencies. */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { parseArgs, promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createConnection } from 'node:net'
import { buildLibraries } from './build-libraries.ts'
import { prepareMcpBuildRuntime, mcpBuildEnvironment, mcpBuildRuntimeDownload } from './mcp-build-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'
import { packageMcpProxy } from './package-mcp-proxy.ts'
import { developmentPaths, initializeDevelopment, initializeDevelopmentProfiles, developmentIssues, developmentDshCli, DEVELOPMENT_ORIGIN } from './development.ts'
import { createDevelopmentProxy } from './development-proxy.ts'

const root = resolve(import.meta.dirname, '..')
const { values, positionals } = parseArgs({ allowPositionals: true, options: { packaging: { type: 'boolean' }, inspect: { type: 'boolean' }, 'skip-build': { type: 'boolean' }, 'node-license': { type: 'string' }, uri: { type: 'string' } } })
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
    powershell: await available('pwsh', ['-NoProfile', '-Command', 'if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }']),
    tar: await available('tar', ['--version']), compiler: await fileExists(join(process.env.WINDIR ?? '', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')),
    license: mcpBuildRuntimeDownload(process.platform, process.version) !== undefined || await fileExists(values['node-license'] ?? join(dirname(process.execPath), 'LICENSE')) }, values.packaging ?? false)
  if (process.platform !== 'win32' || process.arch !== 'x64') issues.push('Native development and packaging require Windows x64.')
  for (const name of ['tsx', 'typescript', 'vitest', '@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot']) {
    try { require.resolve(name + '/package.json') } catch { issues.push(`Run pnpm install --frozen-lockfile (missing ${name}).`) }
  }
  const session = await import('@deepseek-ai/dsh-session')
  if (!['input', 'turn', 'sampling', 'elicitation'].every(name => session.KNOWN_SESSION_EVENT_TYPES.has(`mcp-proxy/${name}`))) issues.push('Session patch missing; reinstall with the repository lockfile.')
  if (issues.length) throw new Error(issues.join('\n'))
  process.stdout.write('Development prerequisites ready. Network access is also needed for first-time release binary downloads.\n')
}

function environment(home: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DSH_') && !name.startsWith('MCP_PROXY_') && name !== 'ELECTRON_RUN_AS_NODE'))
  return { ...inherited, DSH_HOME: home, LOCALAPPDATA: p.localAppData, MCP_PROXY_ORIGIN: DEVELOPMENT_ORIGIN,
    NODE_EXTRA_CA_CERTS: join(p.tls, 'ca.pem'), MCP_PROXY_DEVELOPMENT_ROOT: p.root }
}

/** Only stop the process started by this command; never issue a machine-wide stop to an unknown owner. */
async function foreground(executable: string, args: string[], home: string, log: string): Promise<void> {
  const output = createWriteStream(join(p.logs, log), { flags: 'a', mode: 0o600 })
  const child = spawn(executable, args, { cwd: p.workspace, env: environment(home), windowsHide: true, shell: false, stdio: ['inherit', 'pipe', 'pipe', 'ipc'] })
  child.stdout?.pipe(output, { end: false }); child.stderr?.pipe(output, { end: false })
  child.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(log === 'server.log' ? chunk.toString().replaceAll('http://127.0.0.1:3081/', DEVELOPMENT_ORIGIN + '/') : chunk) })
  child.stderr?.pipe(process.stderr)
  const stop = () => {
    if (child.connected) child.send('mcp-development-stop', error => { if (error) process.stderr.write('Graceful shutdown request failed; inspect the owned development process.\n') })
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const [code, signal] = await once(child, 'exit') as [number | null, string | null]
    if (code !== 0 && code !== 130 && signal !== 'SIGTERM' && signal !== 'SIGINT') throw new Error(`Development child failed (${signal ?? code}); see .artifacts/dev/logs/${log}`)
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); output.end() }
}

async function assertNoLocalOwner(): Promise<void> {
  const socket = createConnection('\\\\.\\pipe\\dsh-mcp-proxy')
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => { reject(new Error('A local MCP service already owns this machine. Exit it normally before development.')) })
      socket.once('error', error => { if ('code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code))) resolve(); else reject(error) })
      socket.setTimeout(2000, () => { reject(new Error('Local MCP service probe timed out')) })
    })
  } finally { socket.destroy() }
}

async function run(): Promise<void> {
  if (command === 'doctor') { await doctor(); return }
  // Use the same pinned, verified runtime as release/test on affected Windows Node versions.
  const executable = await prepareMcpBuildRuntime(root)
  if (executable) {
    await runMcpBuildCommand(executable, ['--import', 'tsx/esm', ...process.argv.slice(1)], root, mcpBuildEnvironment(executable, process.env)); return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native development requires Windows x64')
  await initializeDevelopment(root)
  await initializeDevelopmentProfiles(root, p)
  if (command === 'init') { process.stdout.write(`Development state ready: ${p.root}\n`); return }
  if (command === 'build') { await buildLibraries(root, true); return }
  if (command === 'check') {
    await runMcpBuildCommand(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      'scripts/development.spec.ts', 'scripts/development-proxy.spec.ts', 'scripts/development-signals.spec.ts', 'scripts/download-runtime.spec.ts', 'packages/mcp-proxy/modules/local/tests/tunnel.spec.ts',
      'packages/dsh-plugin/modules/browser/tests/association.spec.ts', 'packages/dsh-plugin/tests/server.spec.ts'], root)
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
  await assertNoLocalOwner()
  if (command === 'runtime') {
    await foreground(process.execPath, [...(values.inspect ? ['--inspect=127.0.0.1:9232'] : []), '--import', signalPreload, '--enable-source-maps', developmentDshCli(root),
      '--profile', 'mcp-proxy', '--config', p.settings], p.localHome, 'runtime.log'); return
  }
  const require = createRequire(join(root, 'packages/mcp-proxy/package.json'))
  const electron = dirname(require.resolve('electron/package.json'))
  if (!await fileExists(join(electron, 'dist/electron.exe'))) await runMcpBuildCommand(process.execPath, [join(electron, 'install.js')], root)
  await runMcpBuildCommand(process.execPath, ['--import', 'tsx/esm', 'packages/mcp-proxy/modules/runtime/scripts/build-native-uri.mjs'], root)
  const output = join(p.root, 'desktop-' + Date.now())
  await mkdir(output)
  const runtime = join(output, 'runtime')
  await packageMcpProxy({ repository: root, output: runtime, nodeExecutable: process.execPath, nodeLicense: resolve(values['node-license'] ?? join(dirname(process.execPath), 'LICENSE')) })
  await runMcpBuildCommand(process.execPath, ['--import', 'tsx/esm', 'packages/mcp-proxy/scripts/package-electron.ts',
    '--runtime', runtime, '--electron-dist', join(electron, 'dist'), '--out', join(output, 'electron'), '--connection-presets', p.presets, '--development'], root)
  const exe = join(output, 'electron/distribution/win-unpacked/mcp-proxy.exe')
  await writeFile(join(p.root, 'desktop-path.txt'), exe + '\n')
  await foreground(exe, values.inspect ? ['--inspect=127.0.0.1:9231'] : [], p.localHome, 'desktop.log')
}
void run().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Development command failed'}\n`); process.exitCode = 1 })
