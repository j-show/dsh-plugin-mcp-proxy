import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import type { InvocationId } from '@j-show/mcp-proxy-protocol'
import { expect, it, onTestFinished } from 'vitest'
import { LocalMcpPool, resolveLocalServices } from '../src/index.ts'
import { httpFixture } from './http-fixtures.ts'

const options = { maxServices: 8, maxFrameBytes: 65536, maxDiscoveryPages: 16,
  maxClientRequests: 8, maxClientRequestRecords: 64, startupTimeoutMs: 10000, callTimeoutMs: 10000, taskCancelTimeoutMs: 1000 }

it('discovers an unchanged stdio MCP and writes a deliverable in its configured local cwd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-proxy-local-'))
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await rm(directory, { recursive: true, force: true }) })
  const services = resolveLocalServices([{ service: 'files', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/files.mjs', import.meta.url))],
  }], directory)
  const pool = await LocalMcpPool.open(services, options)
  owned.pool = pool
  const catalog = await pool.catalog()
  expect(catalog.tools).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'files', name: 'append' })]))
  expect(catalog.services).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'files', instructions: 'Append files in the configured local working directory.' })]))
  const result = await pool.call('files', 'append', { path: 'deliverable.txt', text: 'one local operation' }, new AbortController().signal)
  expect(result).toMatchObject({ content: [{ type: 'text', text: 'written' }], structuredContent: { path: 'deliverable.txt' }, _meta: { local: true } })
  expect(await readFile(join(directory, 'deliverable.txt'), 'utf8')).toBe('one local operation')
  expect(catalog.tools).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'files', name: 'read' })]))
  expect(await pool.call('files', 'read', { path: 'deliverable.txt' }, new AbortController().signal))
    .toMatchObject({ content: [{ type: 'text', text: 'one local operation' }], structuredContent: { path: 'deliverable.txt' }, _meta: { local: true } })
  expect(await pool.call('files', 'read', { path: 'missing.txt' }, new AbortController().signal)).toMatchObject({ isError: true })
  const identity = await pool.call('files', 'pid', {}, new AbortController().signal)
  const pid = (identity.structuredContent as { pid: number }).pid
  expect(pid).toEqual(expect.any(Number))
  await pool.close()
  expect(() => process.kill(pid, 0)).toThrow()
})

it.each(['streamable-http', 'sse'] as const)('discovers and executes %s without forwarding its credentials into the catalog', async (transport) => {
  const fixture = await httpFixture(transport === 'sse')
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'http', transport, url: fixture.url,
    headers: { Authorization: 'Bearer local-fixture-only' },
  }], process.cwd()), options)
  owned.pool = pool
  const catalog = await pool.catalog()
  expect(catalog.tools).toEqual(expect.arrayContaining([expect.objectContaining({ service: 'http', name: 'ping' })]))
  expect(JSON.stringify(catalog)).not.toContain('local-fixture-only')
  expect(catalog.services).toMatchObject([{ service: 'http', directory: process.cwd(), roots: [pathToFileURL(process.cwd()).href] }])
  expect(await pool.call('http', 'ping', {}, new AbortController().signal)).toMatchObject({ content: [{ type: 'text', text: 'pong' }], _meta: { local: true } })
  expect(fixture.observed).toContain('Bearer local-fixture-only')
})

it.each([
  [{ service: 'a', transport: 'stdio', command: '' }],
  [{ service: 'bad alias', transport: 'stdio', command: 'node' }],
  [{ service: 'a', transport: 'unsupported', url: 'http://localhost' }],
  [{ service: 'a', transport: 'stdio', command: 'node' }, { service: 'a', transport: 'stdio', command: 'node' }],
].map(input => ({ input })))('rejects invalid or duplicate local configuration %#', ({ input }) => {
  expect(() => resolveLocalServices(input, process.cwd())).toThrow('Invalid local MCP configuration')
})

it('settles a queued cancellation before the active operation ends, without executing it later', async () => {
  const fixture = await httpFixture(false)
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { fixture.release(); await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'http', transport: 'streamable-http', url: fixture.url }], process.cwd()), options)
  owned.pool = pool
  const first = pool.call('http', 'wait', {}, new AbortController().signal)
    .then(value => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }))
  await fixture.entered
  const controller = new AbortController()
  let state = 'pending'
  const second = pool.call('http', 'ping', {}, controller.signal)
    .then(() => { state = 'executed' }, () => { state = 'cancelled' })
  try {
    controller.abort()
    await Promise.resolve()
    expect(state).toBe('cancelled')
  } finally {
    fixture.release()
    expect(await first).toMatchObject({ ok: true })
    await second
  }
})

it.each(['startupTimeoutMs', 'callTimeoutMs'] as const)('refuses timer overflow in %s', async (field) => {
  await expect(LocalMcpPool.open([], { ...options, [field]: 2_147_483_648 })).rejects.toThrow('Invalid local MCP limit')
})

it('uses the configured discovery deadline for modern MCP services', async () => {
  const fixture = await httpFixture(false, { blockDiscovery: true })
  onTestFinished(async () => { await fixture.close() })
  await expect(LocalMcpPool.open(resolveLocalServices([{ service: 'http', transport: 'streamable-http', url: fixture.url }], process.cwd()), {
    ...options, callTimeoutMs: 25,
  })).rejects.toThrow()
})

it('answers roots locally and correlates model/user requests with their actual parent invocation', async () => {
  const fixture = await httpFixture(true)
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const requests: Array<{ method: string; service: string; invocationId: InvocationId }> = []
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'legacy', transport: 'sse', url: fixture.url, roots: ['assets'] }], process.cwd()), options,
    async (request: { method: string; service: string; invocationId: InvocationId }) => {
      requests.push(request)
      if (request.method === 'sampling') return { role: 'assistant', model: 'fixture-model', content: { type: 'text', text: 'Hello' } }
      return { action: 'accept', content: { name: 'Ada' } }
    })
  owned.pool = pool
  expect(await pool.call('legacy', 'roots', {}, new AbortController().signal)).toMatchObject({ structuredContent: { roots: [{ uri: pathToFileURL(join(process.cwd(), 'assets')).href }] } })
  expect(await pool.call('legacy', 'sample', {}, new AbortController().signal, 'sample-call' as InvocationId)).toMatchObject({ structuredContent: { sampled: { model: 'fixture-model' } } })
  expect(await pool.call('legacy', 'ask', {}, new AbortController().signal, 'question-call' as InvocationId)).toMatchObject({ structuredContent: { answer: { action: 'accept', content: { name: 'Ada' } } } })
  expect(requests.map(({ method, service, invocationId }) => ({ method, service, invocationId }))).toEqual([
    { method: 'sampling', service: 'legacy', invocationId: 'sample-call' },
    { method: 'elicitation', service: 'legacy', invocationId: 'question-call' },
  ])
})

it('retires a cancelled active client before admitting a different invocation context', async () => {
  const fixture = await httpFixture(false)
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { fixture.release(); await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'http', transport: 'streamable-http', url: fixture.url }], process.cwd()), options)
  owned.pool = pool
  const controller = new AbortController()
  const running = pool.call('http', 'wait', {}, controller.signal)
  const cancelled = expect(running).rejects.toMatchObject({ name: 'AbortError' })
  await fixture.entered
  controller.abort()
  await cancelled
  await expect(pool.call('http', 'ping', {}, new AbortController().signal)).rejects.toThrow('Local MCP invocation failed')
})

it('fulfils modern input-required rounds while retaining the original parent identity', async () => {
  const fixture = await httpFixture(false)
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const ids: InvocationId[] = []
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'modern', transport: 'streamable-http', url: fixture.url }], process.cwd()), options, async (request) => {
    ids.push(request.invocationId)
    if (request.method === 'sampling') return { model: 'fixture-model', role: 'assistant', content: { type: 'text', text: 'Hello' } }
    return { action: 'accept', content: { name: 'Ada' } }
  })
  owned.pool = pool
  const result = await pool.call('modern', 'interactive', {}, new AbortController().signal, 'modern-call' as InvocationId)
  expect(result).toMatchObject({ structuredContent: {
    sampling: { model: 'fixture-model' }, elicitation: { action: 'accept', content: { name: 'Ada' } },
    roots: { roots: [{ uri: pathToFileURL(process.cwd()).href }] },
  } })
  expect(ids).toEqual(['modern-call', 'modern-call'])
})

it('does not send callback-owner exceptions back to a local MCP service', async () => {
  const fixture = await httpFixture(true)
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'legacy', transport: 'sse', url: fixture.url }], process.cwd()), options, async () => {
    throw new Error('test-only-remote-credential')
  })
  owned.pool = pool
  const result = await pool.call('legacy', 'sample', {}, new AbortController().signal, 'bad-model-call' as InvocationId)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).not.toContain('test-only-remote-credential')
})

it('bounds tool-initiated model and human requests within one invocation', async () => {
  const fixture = await httpFixture(false)
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  let calls = 0
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'modern', transport: 'streamable-http', url: fixture.url }], process.cwd()), {
    ...options, maxClientRequests: 1,
  }, async () => { calls++; return { model: 'fixture-model', role: 'assistant', content: { type: 'text', text: 'Hello' } } })
  owned.pool = pool
  await expect(pool.call('modern', 'interactive', {}, new AbortController().signal, 'bounded-call' as InvocationId)).rejects.toThrow('Local MCP invocation failed')
  expect(calls).toBe(1)
})

it('quarantines a generation after an SDK deadline, before another invocation can reuse it', async () => {
  const fixture = await httpFixture(false)
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { fixture.release(); await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'http', transport: 'streamable-http', url: fixture.url }], process.cwd()), {
    ...options, callTimeoutMs: 1000,
  })
  owned.pool = pool
  await expect(pool.call('http', 'wait', {}, new AbortController().signal)).rejects.toThrow('Local MCP invocation failed')
  await expect(pool.call('http', 'ping', {}, new AbortController().signal)).rejects.toThrow('Local MCP invocation failed')
})

it('awaits asynchronous callback-owner cleanup before pool shutdown completes', async () => {
  const fixture = await httpFixture(true)
  const owned: { pool?: LocalMcpPool } = {}
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const cleanup = Promise.withResolvers<undefined>()
  onTestFinished(async () => { cleanup.resolve(undefined); await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'legacy', transport: 'sse', url: fixture.url }], process.cwd()), options, async (request) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { request.signal.addEventListener('abort', () => { aborted.resolve(undefined); resolve() }, { once: true }) })
    await cleanup.promise
    return { role: 'assistant', model: 'fixture-model', content: { type: 'text', text: 'late' } }
  })
  owned.pool = pool
  const running = pool.call('legacy', 'sample', {}, new AbortController().signal, 'cleanup-call' as InvocationId)
    .then(() => 'resolved', () => 'rejected')
  await entered.promise
  let closed = false
  const closing = pool.close().then(() => { closed = true })
  try {
    await aborted.promise
    await fixture.disconnected
    await Promise.resolve()
    expect(closed).toBe(false)
  } finally {
    cleanup.resolve(undefined)
    await closing
    await running
  }
})

it('cancels an individual callback while its parent MCP tool remains active', async () => {
  const fixture = await httpFixture(true, { holdAfterCallback: true })
  const owned: { pool?: LocalMcpPool } = {}
  const entered = Promise.withResolvers<AbortSignal>()
  onTestFinished(async () => { fixture.release(); await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'legacy', transport: 'sse', url: fixture.url }], process.cwd()), options, async (request) => {
    entered.resolve(request.signal)
    await new Promise<void>((resolve) => { request.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    return { role: 'assistant', model: 'fixture-model', content: { type: 'text', text: 'cancelled' } }
  })
  owned.pool = pool
  const running = pool.call('legacy', 'sample', {}, new AbortController().signal, 'callback-cancel-call' as InvocationId)
    .then(() => 'resolved', () => 'rejected')
  try {
    const signal = await entered.promise
    fixture.cancelCallback()
    await fixture.callbackStopped
    expect(signal.aborted).toBe(true)
  } finally {
    fixture.release()
    await running
  }
})
