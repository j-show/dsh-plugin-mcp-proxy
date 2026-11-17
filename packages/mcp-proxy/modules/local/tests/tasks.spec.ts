import { expect, it, onTestFinished } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { InvocationId } from '@jshow/app-mcp-proxy/protocol'
import { LocalMcpPool, resolveLocalServices } from '../src/index.ts'
import { httpFixture } from './http-fixtures.ts'

const options = { maxServices: 4, maxFrameBytes: 65536, maxDiscoveryPages: 8,
  maxClientRequests: 8, maxClientRequestRecords: 64, startupTimeoutMs: 10000, callTimeoutMs: 10000,
  taskCancelTimeoutMs: 1000,
}
it('waits for the final result of a task-required MCP tool without submitting it again', async () => {
  const fixture = await httpFixture(true, { taskMode: 'complete' })
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'sse', url: fixture.url }], process.cwd()), options)
  owned.pool = pool
  expect(await pool.call('tasks', 'task', {}, new AbortController().signal, 'task-parent' as InvocationId))
    .toMatchObject({ structuredContent: { taskCalls: 1 } })
  expect(fixture.taskCalls()).toBe(1)
})

it('negotiates a 2025 Streamable HTTP server before executing its required task', async () => {
  const fixture = await httpFixture(false, { legacyProtocol: true, taskMode: 'complete' })
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'streamable-http', url: fixture.url }], process.cwd()), options)
  owned.pool = pool
  expect(await pool.call('tasks', 'task', {}, new AbortController().signal, 'task-parent' as InvocationId))
    .toMatchObject({ structuredContent: { taskCalls: 1 } })
  expect(fixture.taskCalls()).toBe(1)
})

it('hands a negotiated 2025 stdio service to the task-capable SDK before any file operation', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-task-stdio-'))
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await rm(root, { recursive: true, force: true }) })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/task-stdio.mjs', import.meta.url))],
  }], root), options)
  owned.pool = pool
  expect(await pool.call('tasks', 'write-task', {}, new AbortController().signal, 'task-parent' as InvocationId))
    .toMatchObject({ content: [{ text: 'written' }] })
  expect(await readFile(join(root, 'task-effect.txt'), 'utf8')).toBe('once')
})

it('keeps task sampling with its original invocation until the task result is available', async () => {
  const fixture = await httpFixture(true, { taskMode: 'sample' })
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const parents: InvocationId[] = []
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'sse', url: fixture.url }], process.cwd()), options,
    async (request) => {
      parents.push(request.invocationId)
      return { role: 'assistant', model: 'fixture', content: { type: 'text', text: 'Task answer' } }
    })
  owned.pool = pool
  expect(await pool.call('tasks', 'task', {}, new AbortController().signal, 'task-parent' as InvocationId))
    .toMatchObject({ structuredContent: { sampled: { content: { text: 'Task answer' } } } })
  expect(parents).toEqual(['task-parent'])
  expect(fixture.taskCalls()).toBe(1)
})

it('accepts a task callback batched with its creation result before generator continuation', async () => {
  const fixture = await httpFixture(true, { taskMode: 'batched' })
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'sse', url: fixture.url }], process.cwd()), options,
    async () => ({ role: 'assistant', model: 'fixture', content: { type: 'text', text: 'Batched answer' } }))
  owned.pool = pool
  expect(await pool.call('tasks', 'task', {}, new AbortController().signal, 'batch-parent' as InvocationId))
    .toMatchObject({ structuredContent: { sampled: { content: { text: 'Batched answer' } } } })
})

it('rejects a callback claiming another task without invoking its model owner', async () => {
  const fixture = await httpFixture(true, { taskMode: 'foreign-task' })
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  let calls = 0
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'sse', url: fixture.url }], process.cwd()), options,
    async () => { ++calls; return { role: 'assistant', model: 'fixture', content: { type: 'text', text: 'not called' } } })
  owned.pool = pool
  await expect(pool.call('tasks', 'task', {}, new AbortController().signal, 'foreign-parent' as InvocationId)).rejects.toThrow('Local MCP invocation failed')
  expect(calls).toBe(0)
})

it('sends an explicit task cancellation before retiring its client', async () => {
  const fixture = await httpFixture(true, { taskMode: 'wait' })
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'sse', url: fixture.url }], process.cwd()), options)
  owned.pool = pool
  const stop = new AbortController()
  const call = pool.call('tasks', 'task', {}, stop.signal, 'task-parent' as InvocationId)
  const result = call.then(value => ({ value }), (error: unknown) => ({ error }))
  await fixture.taskPolled
  stop.abort()
  expect(await result).toMatchObject({ error: { name: 'AbortError' } })
  await fixture.taskCancelled
  expect(fixture.taskCalls()).toBe(1)
})

it.each(['error', 'bad-output'] as const)('preserves task %s outcome validation', async (taskMode) => {
  const fixture = await httpFixture(true, { taskMode })
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'sse', url: fixture.url }], process.cwd()), options)
  owned.pool = pool
  const call = pool.call('tasks', 'task', {}, new AbortController().signal, 'task-parent' as InvocationId)
  if (taskMode === 'error') expect(await call).toMatchObject({ isError: true, content: [{ text: 'Task tool refusal' }] })
  else await expect(call).rejects.toThrow('Local MCP invocation failed')
  expect(fixture.taskCalls()).toBe(1)
})

it('bounds the whole task lifetime even while status polls keep succeeding', { timeout: 15000 }, async () => {
  const fixture = await httpFixture(true, { taskMode: 'wait' })
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await fixture.close() })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'tasks', transport: 'sse', url: fixture.url }], process.cwd()),
    { ...options, callTimeoutMs: 5000 })
  owned.pool = pool
  await expect(pool.call('tasks', 'task', {}, new AbortController().signal, 'task-parent' as InvocationId)).rejects.toThrow('Local MCP invocation failed')
  await fixture.taskCancelled
  expect(fixture.taskCalls()).toBe(1)
})

it('applies the startup deadline to discovery after protocol negotiation', { timeout: 15000 }, async () => {
  const fixture = await httpFixture(false, { blockDiscovery: true })
  onTestFinished(() => fixture.close())
  await expect(LocalMcpPool.open(resolveLocalServices([{ service: 'blocked', transport: 'streamable-http', url: fixture.url }], process.cwd()),
    { ...options, startupTimeoutMs: 5000 })).rejects.toThrow('Local MCP startup failed')
  expect(fixture.discoveryStarted()).toBe(true)
})
