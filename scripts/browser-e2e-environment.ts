/** Owned real DSH Web fixture for headed browser acceptance. Logs remain private. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateDevelopmentTls, developmentDshCli } from './development.ts'
import { createDevelopmentProxy } from './development-proxy.ts'
import { eventually } from './browser-cdp.ts'

const execute = promisify(execFile)
export function isolatedEnvironment(home: string, localData: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^DSH_|^MCP_PROXY_|^ELECTRON_|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name))),
    DSH_HOME: home, LOCALAPPDATA: localData, npm_config_registry: 'https://registry.npmjs.org/' }
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error }
}
async function port(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback port')
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port
}
export interface WebFixture { origin: string; bootstrap: string; caFile: string; pluginSha256: string; diagnostics(): Array<{ path: string; status: number }>; stop(): Promise<void> }
export interface ServerArtifact { archive: string; sha256: string }
export async function bindServerArtifact(repository: string, directory: string): Promise<ServerArtifact> {
  const metadata = JSON.parse(await readFile(join(repository, 'release/mcp-plugin/release.json'), 'utf8')) as { archive: string }
  if (!/^[A-Za-z0-9_.-]+\.tgz$/.test(metadata.archive)) throw new Error('Invalid server artifact')
  const source = join(repository, 'release/mcp-plugin', metadata.archive), archive = join(resolve(directory), 'server-plugin.tgz')
  const sha256 = createHash('sha256').update(await readFile(source)).digest('hex')
  await copyFile(source, archive)
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== sha256) throw new Error('Server artifact changed during binding')
  return { archive, sha256 }
}
export async function startBrowserWeb(repository: string, directory: string, bound?: ServerArtifact): Promise<WebFixture> {
  const state = resolve(directory)
  const home = join(state, 'server-home'), tls = join(state, 'tls'), workspace = join(state, 'server-workspace')
  for (const dir of [home, tls, workspace]) await mkdir(dir, { recursive: true })
  await generateDevelopmentTls(tls)
  const emptyNpm = join(state, 'public.npmrc'); await writeFile(emptyNpm, 'registry=https://registry.npmjs.org/\n')
  const env = { ...isolatedEnvironment(home, join(state, 'server-app-data')), npm_config_userconfig: emptyNpm }
  const artifact = bound ?? await bindServerArtifact(repository, state)
  const archive = artifact.archive, pluginSha256 = artifact.sha256
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== pluginSha256) throw new Error('Bound server artifact hash mismatch')
  const cli = developmentDshCli(repository)
  await execute(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', archive, '--config.verify-deps-before-run=false'],
    { cwd: workspace, env, timeout: 180000, windowsHide: true, maxBuffer: 4194304 }).catch(async error => {
      await writeFile(join(state, 'server-install.log'), String(error.stdout ?? '') + String(error.stderr ?? '')); throw new Error('Private DSH profile installation failed')
    })
  const backend = await port()
  const requests: Array<{ path: string; status: number }> = []
  const proxy = createDevelopmentProxy(await readFile(join(tls, 'server.pfx')), backend, entry => { if (requests.length < 256) requests.push(entry) })
  proxy.server.listen(0, '127.0.0.1'); await once(proxy.server, 'listening')
  const address = proxy.server.address(); if (!address || typeof address === 'string') throw new Error('No TLS port')
  const origin = `https://localhost:${address.port}`
  let output = ''
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(repository, 'scripts/development-signals.mjs')).href, cli,
    '--profile', 'web', '--host', '127.0.0.1', '--port', String(backend), '--no-open', '--trusted-host', `localhost:${address.port}`],
    { cwd: workspace, env: { ...env, MCP_PROXY_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  const exit = once(child, 'exit')
  void exit.catch(() => {})
  child.stdout?.on('data', bytes => { output += String(bytes) }); child.stderr?.on('data', bytes => { output += String(bytes) })
  const stop = async () => {
    if (child.connected) child.send('mcp-development-stop')
    try { await eventually(async () => child.exitCode !== null || child.signalCode !== null, 'owned DSH shutdown', 15000); await exit }
    finally { await proxy.close(); await writeFile(join(state, 'server.log'), output) }
  }
  try {
    const token = await eventually(async () => {
      if (child.exitCode !== null) throw new Error('Isolated DSH exited before Web readiness')
      return /http:\/\/127\.0\.0\.1:\d+\/\?token=([^\s]+)/.exec(output)?.[1]
    }, 'DSH Web startup', 90000)
    return { origin, bootstrap: `${origin}/?token=${token}`, caFile: join(tls, 'ca.pem'), pluginSha256, diagnostics: () => [...requests], stop }
  } catch (error) { await stop(); throw error }
}
