import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalMcpPool } from '@jshow/app-mcp-proxy/local'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { DshConnectionId } from '@jshow/app-mcp-proxy/protocol'
import { ManagedSettingsStore } from '../src/settings-store.ts'
import { ManagedLocalRuntime, type ManagedDshConnector } from '../src/managed-runtime.ts'

it('reconciles overlapping origin updates without duplicating a resumed DSH channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-concurrent-resume-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const store = await ManagedSettingsStore.open({ filename: join(root, 'settings.json'), directory: root,
    identityFile: join(root, 'identity.yaml'), legacyIdentityRef: 'OLD_KEY', waitMs: 5000 })
  const a = { id: 'a' as DshConnectionId, origin: 'https://a.example', enabled: true, mode: 'device' as const, identityRef: 'DEVICE_A' }
  await store.update(state => ({ ...state, servers: [a] }))
  const opened: string[] = []
  const children: Array<ReturnType<typeof Promise.withResolvers<undefined>>> = []
  const closing = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const runtime = await ManagedLocalRuntime.open(store, { pool: { maxServices: 4, maxFrameBytes: 65536, maxDiscoveryPages: 8,
    maxClientRequests: 8, maxClientRequestRecords: 32, startupTimeoutMs: 2000, callTimeoutMs: 2000, taskCancelTimeoutMs: 1000 },
    maxServers: 4, maxInvocations: 32, reconnectDelayMs: 10 }, async server => {
    opened.push(server.id)
    const initial = server.id === 'a' && opened.filter(id => id === 'a').length === 1
    const done = Promise.withResolvers<undefined>(); children.push(done)
    return { closed: done.promise, publish: async () => {}, associate: async () => {}, close: async () => {
      if (initial) { closing.resolve(undefined); await release.promise }
      done.resolve(undefined)
    } }
  }, new AbortController().signal)
  onTestFinished(async () => { for (const child of children) child.resolve(undefined); await runtime.close() })
  const first = runtime.upsertServer({ ...a, identityRef: 'REPLACEMENT_A' })
  await closing.promise
  const second = runtime.upsertServer({ ...a, id: 'b' as DshConnectionId, origin: 'https://b.example', identityRef: 'DEVICE_B' })
  onTestFinished(async () => { release.resolve(undefined); await Promise.allSettled([first, second]) })
  await expect.poll(async () => (await runtime.snapshot()).servers.find(server => server.id === 'b')?.state).toBe('connected')
  release.resolve(undefined)
  await Promise.all([first, second])
  await expect.poll(() => opened.length).toBeGreaterThanOrEqual(2)
  expect(opened.filter(id => id === 'a')).toHaveLength(2)
  expect(opened.filter(id => id === 'b')).toHaveLength(1)
})

it('keeps independent DSH channels over one pool and persists manual disconnection', async () => {
  vi.stubEnv('REVIEW_DEPLOYMENT_REF', 'synthetic-marker')
  onTestFinished(() => { vi.unstubAllEnvs() })
  const root = await mkdtemp(join(tmpdir(), 'proxy-managed-runtime-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const store = await ManagedSettingsStore.open({ filename: join(root, 'settings.json'), directory: root,
    identityFile: join(root, 'identity.yaml'), legacyIdentityRef: 'OLD_KEY', waitMs: 5000 })
  await store.update(state => ({ ...state, servers: ['a', 'b'].map(id => ({ id, origin: `https://${id}.example`,
    mode: 'device', enabled: true, identityRef: `KEY_${id}` })) }))
  const pools = new Set<LocalMcpPool>()
  const services = new Map<string, readonly string[]>()
  const connected: string[] = []
  const closed: string[] = []
  const connector: ManagedDshConnector = async (server, context) => {
    pools.add(context.pool)
    connected.push(server.id)
    const done = Promise.withResolvers<undefined>()
    return { closed: done.promise, publish: async (catalog) => { services.set(server.id, catalog.services.map(entry => entry.service)) },
      associate: async () => {},
      close: async () => { closed.push(server.id); done.resolve(undefined) } }
  }
  const options = { pool: { maxServices: 4, maxFrameBytes: 65536, maxDiscoveryPages: 8, maxClientRequests: 8,
    maxClientRequestRecords: 32, startupTimeoutMs: 10000, callTimeoutMs: 10000, taskCancelTimeoutMs: 1000 },
  maxServers: 4, maxInvocations: 32, reconnectDelayMs: 5 }
  const runtime = await ManagedLocalRuntime.open(store, options, connector, new AbortController().signal)
  onTestFinished(() => runtime.close())
  await expect.poll(async () => (await runtime.snapshot()).servers.filter(server => server.state === 'connected').length).toBe(2)
  expect(pools.size).toBe(1)
  await store.update(state => ({ ...state, servers: state.servers.map(server => server.id === 'a'
    ? { ...server, origin: 'https://a-new.example', identityRef: 'NEW_IDENTITY_A' } : server) }))
  await runtime.reloadServers()
  await expect.poll(async () => (await runtime.snapshot()).servers.find(server => server.id === 'a')?.origin)
    .toBe('https://a-new.example')
  await store.update(state => ({ ...state, servers: [...state.servers, { id: 'c', origin: 'https://c.example',
    enabled: true, mode: 'legacy', identityRef: 'KEY_c', credentialRef: 'REVIEW_DEPLOYMENT_REF' }] }))
  await runtime.reloadServers()
  await runtime.addMcp({ service: 'files', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('../../local/tests/fixtures/files.mjs', import.meta.url))] })
  expect(services.get('a')).toEqual(['files'])
  expect(services.get('b')).toEqual(['files'])
  await expect(runtime.addMcp({ service: 'broken', transport: 'stdio', command: process.execPath,
    args: ['-e', 'process.exit(1)'] })).rejects.toThrow()
  expect((await runtime.snapshot()).services.map(entry => entry.service)).toEqual(['files'])
  const [pool] = pools
  const identity = await pool!.call('files', 'pid', {}, new AbortController().signal)
  expect(await pool!.call('files', 'has-env', { name: 'REVIEW_DEPLOYMENT_REF' }, new AbortController().signal))
    .toMatchObject({ structuredContent: { present: false } })
  const pid = (identity.structuredContent as { pid:number }).pid
  await runtime.removeMcp('files')
  expect(services.get('a')).toEqual([])
  expect(services.get('b')).toEqual([])
  expect(() => process.kill(pid, 0)).toThrow()
  await runtime.disconnect('a' as DshConnectionId)
  expect((await store.read()).servers.find(server => server.id === 'a')?.enabled).toBe(false)
  expect((await runtime.snapshot()).servers.find(server => server.id === 'b')?.state).toBe('connected')
  expect(closed).not.toContain('b')
  await runtime.close()
  const restarted = await ManagedLocalRuntime.open(store, options, connector, new AbortController().signal)
  onTestFinished(() => restarted.close())
  await expect.poll(async () => (await restarted.snapshot()).servers.find(server => server.id === 'b')?.state).toBe('connected')
  expect(connected.filter(id => id === 'a')).toHaveLength(2)
})
