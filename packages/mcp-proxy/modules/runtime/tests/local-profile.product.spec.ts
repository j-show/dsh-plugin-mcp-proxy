/** Built-artifact acceptance: requires the built CLI/packages, or MCP_PROXY_RUNTIME_DIR pointing at a packaged local product. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:https'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { acceptProxyIdentity, decodeFrame, ProxyChannel, type ProxyFrame } from '@jshow/app-mcp-proxy/protocol'
import { startBackgroundService } from '../src/background.ts'
import { machineControlAddress, requestLocalStatus, requestLocalStop } from '../src/control.ts'
import { acquireServiceSlot } from './product-service-slot.ts'

const repository = resolve(import.meta.dirname, '../../../../..')
const packaged = process.env.MCP_PROXY_RUNTIME_DIR
const desktopRuntime = process.env.MCP_PROXY_DESKTOP_RUNTIME
const desktopExecutable = process.env.MCP_PROXY_DESKTOP_EXE
const desktopData = process.env.MCP_PROXY_DESKTOP_DATA
const desktopInputs = [desktopRuntime, desktopExecutable, desktopData]
if (desktopInputs.some(value => value !== undefined) && desktopInputs.some(value => value === undefined)) {
  throw new Error('Tauri acceptance requires its executable, qualified runtime and test-owned application data')
}
const node = desktopRuntime !== undefined ? join(resolve(desktopRuntime), 'resources/dsh/runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  : packaged === undefined ? process.execPath : join(resolve(packaged), 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
const cli = desktopRuntime !== undefined ? join(resolve(desktopRuntime), 'resources/dsh/lib/bin.js')
  : packaged === undefined ? join(resolve(createRequire(join(repository,'packages/mcp-proxy/package.json')).resolve('@deepseek-ai/dsh/package.json'),'..'), 'lib/bin.js') : join(resolve(packaged), 'lib/bin.js')

async function fixture(acknowledge: boolean, projectEnvironment = false) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-profile-acceptance-'))
  const home = join(root, 'home')
  const profile = join(home, 'profiles/mcp-proxy')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile,'package.json'), JSON.stringify({private:true,type:'module',dependencies:{},dsh:{profile:{bundles:['@jshow/app-mcp-proxy']}}}))
  await writeFile(join(profile,'cordis.patch.yml'),'[]\n')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const token = randomUUID()
  const credential = 'MCP_ACCEPTANCE_' + randomUUID().replaceAll('-', '_')
  const cert = join(repository, 'packages/mcp-proxy/modules/runtime/tests/fixtures/localhost-cert.pem')
  const server = createServer({ cert: await readFile(cert), key: await readFile(join(repository,
    'packages/mcp-proxy/modules/runtime/tests/fixtures/localhost-key.pem')) })
  const sockets = new WebSocketServer({ noServer: true })
  const catalog = Promise.withResolvers<Extract<ProxyFrame, { kind: 'catalog' }>>()
  void catalog.promise.catch((_error: unknown) => { /* The owning command or catalog assertion reports this failure. */ })
  const state: { channel?: ProxyChannel; proof?: Promise<unknown>; pid?: number } = {}
  const starters = new Set<ChildProcess>()
  const slot: { release?: () => Promise<void> } = {}
  onTestFinished(async () => {
    try {
      if (state.pid !== undefined && running(state.pid)) {
        await requestLocalStop(await machineControlAddress(), 5000, state.pid)
        await expect.poll(() => running(state.pid!), { timeout: 10000 }).toBe(false)
      }
      await Promise.all([...starters].map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }))
      await state.channel?.close()
      for (const socket of sockets.clients) socket.terminate()
      await state.proof
      await new Promise<void>((done) => { sockets.close(() => { done() }) })
      await new Promise<void>((done) => { server.close(() => { done() }) })
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } finally { await slot.release?.() }
  })
  slot.release = await acquireServiceSlot()
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/mcp-proxy/connect' || request.headers.authorization !== `Bearer ${token}`) { socket.destroy(); return }
    sockets.handleUpgrade(request, socket, head, peer => sockets.emit('connection', peer))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected fixture TLS listener')
  const origin = `https://127.0.0.1:${address.port}`
  sockets.on('connection', (socket) => {
    state.proof = acceptProxyIdentity(socket, origin, { timeoutMs: 10000, maxFrameBytes: 1048576 }, (identity) => {
      state.channel = new ProxyChannel(socket, { generation: identity.generation, maxFrameBytes: 1048576,
        maxInvocations: 64, maxPending: 4,
      })
      socket.on('message', (data) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
        const frame = decodeFrame(bytes.toString(), 1048576)
        if (frame.kind !== 'catalog') return
        if (acknowledge) socket.send(JSON.stringify({ v: 1, kind: 'catalog-accepted', revision: frame.revision }))
        catalog.resolve(frame)
      })
    }).catch((error: unknown) => { catalog.reject(error) })
  })
  const identity = join(root, 'identity.yaml')
  if (projectEnvironment) {
    await writeFile(identity, 'version: 1\nrefs: {}\n', { mode: 0o600 })
    await writeFile(join(home, '.env'), `${credential}=wrong-home-value\n`)
    await writeFile(join(root, '.env'), `${credential}=${token}\n`)
  } else await writeFile(identity, `version: 1\nrefs:\n  ${credential}: ${token}\n`, { mode: 0o600 })
  const marker = join(root, 'mcp-processes.jsonl')
  async function startupDiagnostic(): Promise<string> {
    const log = await readFile(join(profile, 'mcp-proxy.log'), 'utf8').catch(() => '')
    // Report only fixed application stages; raw DSH logs can contain private paths or credentials.
    return log.split('\n').filter(line => /^mcp-proxy: [a-z-]+ failed$/.test(line.trim())).join('\n') || 'No fixed startup stage reported'
  }
  const settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ server: { origin, credentialRef: credential, caFile: cert },
    identityFile: identity, directory: workspace, services: [{ service: 'files', transport: 'stdio',
      command: node,
      args: [join(repository, 'packages/mcp-proxy/modules/local/tests/fixtures/files.mjs')], env: { MCP_FIXTURE_START_MARKER: marker },
    }],
  }))
  async function command(...args: string[]) {
    const command = desktopExecutable === undefined ? node : resolve(desktopExecutable)
    const argv = desktopExecutable === undefined ? [cli, '--profile', 'mcp-proxy', '--config', settings, ...args]
      : ['--config', settings, ...args]
    const child = spawn(command, argv, {
      cwd: root, env: { ...process.env, NODE_PATH: undefined, NODE_OPTIONS: undefined, DSH_HOME: home,
        ...(desktopData === undefined ? {} : { LOCALAPPDATA: desktopData }),
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    starters.add(child)
    let diagnostic = ''
    child.stdout.on('data', (data) => { diagnostic = (diagnostic + String(data)).slice(-8000) })
    child.stderr.on('data', (data) => { diagnostic = (diagnostic + String(data)).slice(-8000) })
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => { resolve([code, signal]) })
    })
    starters.delete(child)
    if (code !== 0 || signal !== null) throw new Error(`Local profile command failed: ${diagnostic}\n${await startupDiagnostic()}`)
  }
  async function pids() {
    return (await readFile(marker, 'utf8')).trim().split('\n').map((line) => {
      const value: unknown = JSON.parse(line)
      if (typeof value !== 'object' || value === null || !('pid' in value) || typeof value.pid !== 'number') throw new Error('Invalid MCP PID marker')
      return value.pid
    })
  }
  return { root, home, profile, workspace, settings, catalog: catalog.promise, state, command, pids, startupDiagnostic }
}

it.skipIf(process.env.MCP_PROXY_PRODUCT_TESTS !== '1')('runs the mcp-proxy profile in the background, delivers a local file and joins stopped MCP processes', async () => {
  const test = await fixture(true)
  await test.command('--start')
  const status = await requestLocalStatus(await machineControlAddress(), 5000)
  test.state.pid = status.pid
  expect(status.ready).toBe(true)
  const catalog = await test.catalog
  if (test.state.channel === undefined) throw new Error('Expected admitted local connection')
  await test.state.channel.invoke({ revision: catalog.revision, service: 'files', name: 'append',
    args: { path: 'delivered.txt', text: 'local profile delivery' },
  }, 10000)
  expect(await readFile(join(test.workspace, 'delivered.txt'), 'utf8')).toBe('local profile delivery')
  const readBack = await test.state.channel.invoke({ revision: catalog.revision, service: 'files', name: 'read',
    args: { path: 'delivered.txt' },
  }, 10000)
  expect(JSON.stringify(readBack)).toContain('local profile delivery')
  const children = await test.pids()
  await test.command('--stop')
  await expect.poll(() => running(status.pid), { timeout: 10000 }).toBe(false)
  for (const pid of children) await expect.poll(() => running(pid), { timeout: 10000 }).toBe(false)
}, 300000)

it.skipIf(process.env.MCP_PROXY_PRODUCT_TESTS !== '1')('cancels a real profile after MCP startup but before catalog acknowledgement without orphaning either process', async () => {
  const test = await fixture(false)
  const stop = new AbortController()
  const outcome = startBackgroundService({ node, cli, cwd: test.root, home: test.home, profile: 'mcp-proxy', profileDir: test.profile,
    settings: test.settings, address: await machineControlAddress(), controlTimeoutMs: 1000, startupTimeoutMs: 30000,
    pollIntervalMs: 20, shutdownTimeoutMs: 2000,
  }, stop.signal).then(value => ({ value }), (error: unknown) => ({ error }))
  onTestFinished(async () => { stop.abort(); await outcome })
  await Promise.race([test.catalog, outcome.then(async () => { throw new Error(`Profile startup settled before the withheld catalog acknowledgement: ${await test.startupDiagnostic()}`) })])
  const status = await requestLocalStatus(await machineControlAddress(), 5000)
  test.state.pid = status.pid
  expect(status.ready).toBe(false)
  const children = await test.pids()
  expect(children.some(pid => running(pid))).toBe(true)
  stop.abort()
  const cancelled = await outcome
  if ('error' in cancelled && cancelled.error instanceof Error && cancelled.error.message !== 'Local MCP background startup failed') throw cancelled.error
  expect(cancelled).toMatchObject({ error: { message: 'Local MCP background startup failed' } })
  await expect.poll(() => running(status.pid), { timeout: 10000 }).toBe(false)
  for (const pid of children) await expect.poll(() => running(pid), { timeout: 10000 }).toBe(false)
}, 300000)

it.skipIf(process.env.MCP_PROXY_PRODUCT_TESTS !== '1')('retains invoking-directory environment precedence when starting the background profile', async () => {
  const test = await fixture(true, true)
  await test.command('--start')
  const status = await requestLocalStatus(await machineControlAddress(), 5000)
  test.state.pid = status.pid
  expect(status.ready).toBe(true)
  await test.command('--stop')
  await expect.poll(() => running(status.pid), { timeout: 10000 }).toBe(false)
  for (const pid of await test.pids()) await expect.poll(() => running(pid), { timeout: 10000 }).toBe(false)
}, 300000)

function running(pid: number): boolean {
  try { return process.kill(pid, 0) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}
