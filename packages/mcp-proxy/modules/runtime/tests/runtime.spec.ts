import { once } from 'node:events'
import { createServer } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { acceptProxyIdentity, decodeFrame, ProxyChannel, type ProxyFrame } from '@jshow/app-mcp-proxy/protocol'
import { WebSocketServer } from 'ws'
import { expect, it, onTestFinished, vi, beforeAll, afterAll } from 'vitest'
import Runtime from '../src/index.ts'
import * as Startup from '../src/startup.ts'
import { createProcessInspector } from './support/process-inspector.ts'

// Native lifetime cases use independent processes; this fixture must not put its shared worker in a Job.
vi.mock('../src/windows-process-job.ts', () => ({ holdWindowsServiceJob: () => ({ release: async () => {} }) }))
const controlFixture = vi.hoisted(() => ({ address: '', directory: '' }))
vi.mock('../src/control.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/control.ts')>('../src/control.ts')
  return { ...actual, machineControlAddress: async () => controlFixture.address }
})
beforeAll(async () => {
  controlFixture.directory = await mkdtemp(join(tmpdir(), 'mcp-runtime-control-'))
  controlFixture.address = process.platform === 'win32'
    ? `\\\\.\\pipe\\mcp-runtime-test-${randomUUID()}` : join(controlFixture.directory, 'control.sock')
})
afterAll(() => rm(controlFixture.directory, { recursive: true, force: true }))

// Retirement includes SDK process shutdown, reconnect delay, discovery and a new proof.
// Match the configured recovery envelope instead of assuming a loaded Windows host takes <5s.
const recoverySpec = Runtime.Config({ settingsFile: 'fixture' })
const cancellationRecoveryBudget = recoverySpec.reconnectDelayMs + 2 * recoverySpec.startupTimeoutMs

async function bootApplication(context: Context, argv: string[], exit: (code: number) => void,
  options: { omitCredentials?: boolean; startupTimeoutMs?: number } = {}) {
  context.provide('cmdlineArgs', { get: () => argv })
  context.provide('appExit', exit)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-credentials-local', Credentials],
    ['@jshow/app-mcp-proxy/runtime', Runtime], ['@jshow/app-mcp-proxy/runtime/startup', Startup],
  ])
  context.loader.internal = { version: 'v2', async import(name: string) {
    if (!modules.has(name)) throw new Error('Unexpected runtime composition module')
    return modules.get(name)
  } } as unknown as NonNullable<typeof context.loader.internal>
  const entries = composeEntries([loadOverlayPatches('mcp-proxy', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))])
  const pending: Promise<unknown>[] = []
  for (const entry of entries) {
    if (options.omitCredentials && entry.name === '@deepseek-ai/dsh-credentials-local') continue
    const selected = entry.name === '@jshow/app-mcp-proxy/runtime'
      ? { ...entry, config: { ...entry.config, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 } }
      : entry.name === '@jshow/app-mcp-proxy/runtime/startup' && options.startupTimeoutMs !== undefined
        ? { ...entry, config: { serviceStartTimeoutMs: options.startupTimeoutMs } } : entry
    const work = context.loader.create(selected)
    if (options.omitCredentials && entry.name === '@jshow/app-mcp-proxy/runtime') {
      pending.push(work)
      void work.catch((_disposedPendingEntry) => { /* The owning test joins this outcome after scope disposal. */ })
    } else await work
  }
  if (!options.omitCredentials) await context.loader.await()
  return pending
}

it('fails startup when a required profile provider remains pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-missing-provider-'))
  const context = new Context()
  let pending: Promise<unknown>[] = []
  onTestFinished(async () => {
    await context.fiber.dispose()
    await Promise.allSettled(pending)
    await rm(root, { recursive: true, force: true })
  })
  const filename = join(root, 'settings.json')
  await writeFile(filename, JSON.stringify({ version: 2, directory: root, identityFile: join(root, 'identity.yaml'),
    servers: [], services: [] }), { mode: 0o600 })
  const failed = Promise.withResolvers<number>()
  pending = await bootApplication(context, ['--config', filename], code => failed.resolve(code),
    { omitCredentials: true, startupTimeoutMs: 50 })
  const entry = [...context.loader.entries()].find(entry => entry.options.name === '@jshow/app-mcp-proxy/runtime')
  expect(entry).toBeDefined()
  expect(entry?.fiber?.state).not.toBe(2)
  expect(entry?.fiber?.state).not.toBe(3)
  expect(await failed.promise).toBe(1)
  expect(context.get('mcpProxyLocal')).toBeUndefined()
})

it('boots an empty managed profile and serves redacted desktop state before any DSH connects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-managed-profile-'))
  const context = new Context()
  onTestFinished(async () => { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ version: 2, directory: root, identityFile: join(root, 'identity.yaml'),
    servers: [], services: [] }), { mode: 0o600 })
  const exits: number[] = []
  await bootApplication(context, ['--config', settings], (code) => { exits.push(code) })
  const { requestLocalStatus, requestLocalManagement } = await import('../src/control.ts')
  expect(await requestLocalStatus(controlFixture.address, 2000)).toMatchObject({ ready: true })
  const reply = await requestLocalManagement(controlFixture.address, { kind: 'snapshot' }, 2000, 65536)
  expect(reply).toMatchObject({ ok: true, snapshot: { version: 2, servers: [], services: [] } })
  expect(exits).toEqual([])
})

async function mountRuntime(trustCA = true, exit: (code: number) => void = () => { throw new Error('Unexpected application exit') },
  services: readonly string[] = ['files'], expectedFailure = false) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-proxy-app-'))
  const context = new Context()
  const cert = await readFile(new URL('./fixtures/localhost-cert.pem', import.meta.url))
  const key = await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url))
  const server = createServer({ cert, key })
  const websocket = new WebSocketServer({ server, maxPayload: 65536 })
  const catalog = Promise.withResolvers<Extract<ProxyFrame, { kind: 'catalog' }>>()
  const host: { channel?: ProxyChannel; proof?: Promise<unknown>; catalog?: Extract<ProxyFrame, { kind: 'catalog' }> } = {}
  const endpoints: string[] = []
  const transactions: string[] = []
  const channels = new Set<ProxyChannel>()
  onTestFinished(async () => {
    await context.fiber.dispose()
    await Promise.all([...channels].map(channel => channel.close()))
    for (const socket of websocket.clients) socket.terminate()
    await host.proof
    await new Promise<void>((resolve) => { websocket.close(() => { resolve() }) })
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TLS fixture port')
  const origin = `https://127.0.0.1:${address.port}`
  websocket.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer deployment-test-token')
    host.proof = acceptProxyIdentity(socket, origin, { timeoutMs: 2000, maxFrameBytes: 65536 }, (peer) => {
      endpoints.push(peer.endpointId)
      host.channel = new ProxyChannel(socket, { generation: peer.generation, maxFrameBytes: 65536, maxInvocations: 64, maxPending: 4 })
      channels.add(host.channel)
      socket.on('message', (data) => {
        const frame = decodeFrame(data.toString(), 65536)
        if (frame.kind === 'association') transactions.push(frame.requestId)
        if (frame.kind !== 'catalog') return
        host.catalog = frame
        socket.send(JSON.stringify({ v: 1, kind: 'catalog-accepted', revision: frame.revision }))
        catalog.resolve(frame)
      })
    })
  })
  const identityFile = join(root, 'identity.yaml')
  await writeFile(identityFile, 'version: 1\nrefs:\n  TEST_PROXY_TOKEN: deployment-test-token\n', { mode: 0o600 })
  const settingsFile = join(root, 'config.json')
  await writeFile(settingsFile, JSON.stringify({ server: { origin, credentialRef: 'TEST_PROXY_TOKEN',
    ...(trustCA ? { caFile: fileURLToPath(new URL('./fixtures/localhost-cert.pem', import.meta.url)) } : {}),
  }, identityFile, directory: root, services: services.map(service => ({ service, transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('../../local/tests/fixtures/files.mjs', import.meta.url))],
    env: { MCP_FIXTURE_START_MARKER: join(root, 'mcp-started') },
  })) }))
  const startup = bootApplication(context, ['--config', settingsFile], exit)
  if (expectedFailure) await expect(startup).rejects.toThrow('Local MCP proxy startup failed')
  else await startup
  return { context, catalog, host, root, endpoints, identityFile, settingsFile, transactions }
}

it('starts from one Loader runtime entry and invokes an actual local MCP over authenticated TLS', async () => {
  const { context, catalog, host, root } = await mountRuntime()
  expect(context.get('mcpProxyLocal')?.connected).toBe(true)
  const discovered = await catalog.promise
  if (host.channel === undefined) throw new Error('Expected authenticated host channel')
  await host.channel.invoke({ revision: discovered.revision, service: 'files', name: 'append', args: { path: 'result.txt', text: 'local product runtime' } }, 2000)
  expect(await readFile(join(root, 'result.txt'), 'utf8')).toBe('local product runtime')
})

it('forwards an actual stdio MCP sampling continuation to its originating remote invocation', async () => {
  const { catalog, host } = await mountRuntime()
  const discovered = await catalog.promise
  if (host.channel === undefined) throw new Error('Expected authenticated channel')
  const methods: string[] = []
  const result = await host.channel.invoke({ revision: discovered.revision, service: 'files', name: 'sample', args: {} }, 5000,
    undefined, async (request) => {
      methods.push(request.method)
      return { role: 'assistant', model: 'fixture-model', content: { type: 'text', text: 'Hello from remote' } }
    })
  expect(methods).toEqual(['sampling'])
  expect(result.structuredContent).toMatchObject({ sample: { model: 'fixture-model', content: { text: 'Hello from remote' } } })
})

it('retains the installation identity when the local runtime restarts', async () => {
  const { context, endpoints, identityFile } = await mountRuntime()
  expect(context.get('mcpProxyLocal')?.connected).toBe(true)
  expect(await readFile(identityFile, 'utf8')).toContain('MCP_PROXY_INSTALLATION_KEY')
  const entry = [...context.loader.entries()].find(entry => entry.options.name === '@jshow/app-mcp-proxy/runtime')
  if (entry === undefined) throw new Error('Expected local runtime entry')
  await context.loader.update(entry.id, { disabled: true })
  await context.loader.await()
  expect(context.get('mcpProxyLocal')).toBeUndefined()
  await context.loader.update(entry.id, { disabled: false })
  await context.loader.await()
  expect(context.get('mcpProxyLocal')?.connected).toBe(true)
  expect(endpoints).toHaveLength(2)
  expect(endpoints[1]).toBe(endpoints[0])
})

it('reconnects after a server disconnect without restarting its local MCP process', { timeout: 15000 }, async () => {
  const { context, host, endpoints, catalog } = await mountRuntime()
  const initial = host.channel
  if (initial === undefined) throw new Error('Expected authenticated channel')
  const discovered = await catalog.promise
  const request = { revision: discovered.revision, service: 'files', name: 'pid', args: {} }
  const before = await initial.invoke(request, 2000)
  await initial.close()
  await expect.poll(() => endpoints.length, { timeout: 10000 }).toBe(2)
  await expect.poll(() => context.get('mcpProxyLocal')?.connected).toBe(true)
  expect(endpoints[1]).toBe(endpoints[0])
  expect(host.channel).not.toBe(initial)
  expect(await host.channel?.invoke(request, 2000)).toEqual(before)
})

it('recovers a retired MCP after an in-flight disconnect without replaying its file operation', { timeout: 15000 }, async () => {
  const { context, host, endpoints, catalog, root } = await mountRuntime()
  const initial = host.channel
  if (initial === undefined) throw new Error('Expected authenticated channel')
  const discovered = await catalog.promise
  const operation = initial.invoke({ revision: discovered.revision, service: 'files', name: 'append-wait',
    args: { path: 'once.txt', text: 'once', release: 'never-released' },
  }, 10000)
  const interrupted = expect(operation).rejects.toMatchObject({ code: 'unknown' })
  await expect.poll(async () => {
    try { return await readFile(join(root, 'once.txt'), 'utf8') } catch (_error) { return undefined }
  }).toBe('once')
  await initial.close()
  await interrupted
  await expect.poll(() => endpoints.length, { timeout: 10000 }).toBe(2)
  await expect.poll(() => context.get('mcpProxyLocal')?.connected).toBe(true)
  expect(await host.channel?.invoke({ revision: host.catalog!.revision, service: 'files', name: 'append',
    args: { path: 'after.txt', text: 'recovered' },
  }, 2000)).toMatchObject({ _meta: { local: true } })
  expect(await readFile(join(root, 'once.txt'), 'utf8')).toBe('once')
  expect(await readFile(join(root, 'after.txt'), 'utf8')).toBe('recovered')
})

it('replaces a retired MCP after parent cancellation without waiting for a network failure', { timeout: cancellationRecoveryBudget + 10000 }, async () => {
  const { context, host, endpoints, catalog, root } = await mountRuntime()
  const initial = host.channel
  if (initial === undefined) throw new Error('Expected authenticated channel')
  const discovered = await catalog.promise
  const stop = new AbortController()
  const operation = initial.invoke({ revision: discovered.revision, service: 'files', name: 'append-wait',
    args: { path: 'cancelled-once.txt', text: 'once', release: 'never-released' },
  }, 10000, stop.signal)
  const outcome = operation.then(value => ({ value }), (error: unknown) => ({ error }))
  await expect.poll(async () => {
    try { return await readFile(join(root, 'cancelled-once.txt'), 'utf8') } catch (_error) { return undefined }
  }).toBe('once')
  stop.abort()
  expect(await outcome).toMatchObject({ error: { code: 'unknown' } })
  await expect.poll(() => endpoints.length, { timeout: cancellationRecoveryBudget }).toBe(2)
  await expect.poll(() => context.get('mcpProxyLocal')?.connected).toBe(true)
  expect(await host.channel?.invoke({ revision: host.catalog!.revision, service: 'files', name: 'append',
    args: { path: 'after-cancel.txt', text: 'recovered' },
  }, 2000)).toMatchObject({ _meta: { local: true } })
  expect(await readFile(join(root, 'cancelled-once.txt'), 'utf8')).toBe('once')
})

it('detects an idle local MCP process exit through connection health supervision and restores it', { timeout: 35000 }, async () => {
  const { context, host, endpoints, catalog, settingsFile } = await mountRuntime()
  const entry = [...context.loader.entries()].find(entry => entry.options.name === '@jshow/app-mcp-proxy/runtime')
  expect(entry?.options.config).toMatchObject({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 })
  const spec = Runtime.Config({ settingsFile, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1000 })
  // Recovery owns a complete discovery budget and a fresh TLS proof budget.
  const recoveryBudget = spec.heartbeatIntervalMs + spec.reconnectDelayMs + 2 * spec.startupTimeoutMs
  const discovered = await catalog.promise
  if (host.channel === undefined) throw new Error('Expected authenticated channel')
  const request = { revision: discovered.revision, service: 'files', name: 'pid', args: {} }
  const before = await host.channel.invoke(request, 2000)
  const content = before.structuredContent
  if (typeof content !== 'object' || content === null || Array.isArray(content)) throw new Error('Expected fixture process result')
  const pid = content['pid']
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('Expected owned fixture process identity')
  const inspector = createProcessInspector()
  const identity = inspector.snapshot().tree(pid).find(process => process.pid === pid)
  if (identity === undefined) throw new Error('Owned MCP process was not observed')
  process.kill(pid, 'SIGTERM')
  await expect.poll(() => inspector.isAlive(identity), { timeout: 5000 }).toBe(false)
  await expect.poll(() => endpoints.length, { timeout: recoveryBudget }).toBe(2)
  await expect.poll(() => context.get('mcpProxyLocal')?.connected).toBe(true)
  const after = await host.channel?.invoke({ ...request, revision: host.catalog!.revision }, 2000)
  expect(after?.structuredContent).toMatchObject({ pid: expect.any(Number) })
  expect(after?.structuredContent).not.toMatchObject({ pid })
})

it('marks concurrent sibling operations unknown when restoring a retired client and never replays either', { timeout: cancellationRecoveryBudget + 10000 }, async () => {
  const { context, host, endpoints, catalog, root } = await mountRuntime(true, undefined, ['files', 'extra'])
  const discovered = await catalog.promise
  const initial = host.channel
  if (initial === undefined) throw new Error('Expected authenticated channel')
  const stop = new AbortController()
  const outcomes = ['files', 'extra'].map((service, index) => initial.invoke({ revision: discovered.revision, service, name: 'append-wait',
    args: { path: `${service}-once.txt`, text: service, release: 'never-released' },
  }, 10000, index === 0 ? stop.signal : undefined).then(value => ({ value }), (error: unknown) => ({ error })))
  await Promise.all(['files', 'extra'].map(service => expect.poll(async () => {
    try { return await readFile(join(root, `${service}-once.txt`), 'utf8') } catch (_error) { return undefined }
  }).toBe(service)))
  stop.abort()
  expect(await Promise.all(outcomes)).toMatchObject([{ error: { code: 'unknown' } }, { error: { code: 'unknown' } }])
  await expect.poll(() => endpoints.length, { timeout: cancellationRecoveryBudget }).toBe(2)
  await expect.poll(() => context.get('mcpProxyLocal')?.connected).toBe(true)
  for (const service of ['files', 'extra']) {
    await host.channel?.invoke({ revision: host.catalog!.revision, service, name: 'append',
      args: { path: `${service}-after.txt`, text: 'recovered' },
    }, 2000)
    expect(await readFile(join(root, `${service}-once.txt`), 'utf8')).toBe(service)
    expect(await readFile(join(root, `${service}-after.txt`), 'utf8')).toBe('recovered')
  }
})

it('refuses an untrusted server certificate without disabling TLS validation', async () => {
  const exits: number[] = []
  const { context, endpoints } = await mountRuntime(false, (code) => { exits.push(code) }, ['files'], true)
  expect(context.get('mcpProxyLocal')).toBeUndefined()
  expect(endpoints).toEqual([])
  expect(exits).toEqual([1])
})

it('requests a failing launcher exit when local configuration cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-invalid-config-'))
  const context = new Context()
  onTestFinished(async () => { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const exits: number[] = []
  await expect(bootApplication(context, ['--config', join(root, 'missing.json')], (code) => { exits.push(code) }))
    .rejects.toThrow('Invalid or unreadable mcp-proxy configuration')
  expect(exits).toEqual([1])
  expect(context.get('mcpProxyLocal')).toBeUndefined()
})

it('refuses a second local runtime before starting another MCP', async () => {
  const first = await mountRuntime()
  expect(first.context.get('mcpProxyLocal')?.connected).toBe(true)
  const exits: number[] = []
  const second = await mountRuntime(true, (code) => { exits.push(code) }, ['files'], true)
  expect(exits).toEqual([1])
  expect(second.context.get('mcpProxyLocal') === undefined).toBe(true)
  expect(first.context.get('mcpProxyLocal')?.connected).toBe(true)
  await expect(readFile(join(second.root, 'mcp-started'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('forwards URI activation to the existing runtime without starting another MCP', async () => {
  const running = await mountRuntime()
  const helper = new Context()
  onTestFinished(async () => { await helper.fiber.dispose() })
  let exitCode: number | undefined
  const id = 'a'.repeat(43)
  await bootApplication(helper, ['--config', join(running.root, 'unused-config.json'), '--associate', `mcp-proxy://associate/${id}`],
    (code) => { exitCode = code })
  expect(exitCode).toBe(0)
  expect(helper.get('mcpProxyLocal')).toBeUndefined()
  await expect.poll(() => running.transactions).toEqual([id])
})

it('requests graceful shutdown through the local stop entry', async () => {
  let shutdown: Promise<void> | undefined
  let stopped: number | undefined
  const receiver: Awaited<ReturnType<typeof mountRuntime>> = await mountRuntime(true,
    (code) => { stopped = code; shutdown = receiver.context.fiber.dispose() })
  const helper = new Context()
  onTestFinished(async () => { await helper.fiber.dispose(); await shutdown })
  let helperExit: number | undefined
  await bootApplication(helper, ['--config', receiver.settingsFile, '--stop'], (code) => { helperExit = code })
  expect(helperExit).toBe(0)
  await expect.poll(() => stopped).toBe(0)
  await shutdown
  expect(receiver.context.get('mcpProxyLocal')).toBeUndefined()
})
