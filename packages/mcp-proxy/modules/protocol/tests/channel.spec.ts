import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { openSockets } from './helpers/sockets.ts'
import { ProxyChannel } from '../src/channel.ts'
import type { GenerationId } from '../src/protocol.ts'

it('expires an authenticated peer that does not answer application heartbeats', async () => {
  const { client, remote } = await openSockets()
  const host = new ProxyChannel(remote, { generation: 'g' as GenerationId, maxFrameBytes: 4096,
    maxInvocations: 10, maxPending: 2, heartbeat: { intervalMs: 10, timeoutMs: 1000 },
  })
  onTestFinished(async () => { await host.close() })
  const closed = once(client, 'close')
  expect(JSON.parse(String((await once(client, 'message'))[0]))).toMatchObject({ kind: 'ping' })
  await closed
  await expect(host.invoke({ revision: 'r', service: 'files', name: 'read', args: {} }, 1000))
    .rejects.toMatchObject({ code: 'unavailable' })
})

it('keeps a responsive channel alive across successive heartbeats', async () => {
  const { client, remote } = await openSockets()
  const generation = 'g' as GenerationId
  const local = new ProxyChannel(client, { generation, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2,
    onInvoke: async () => ({ content: [] }),
  })
  const host = new ProxyChannel(remote, { generation, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2,
    heartbeat: { intervalMs: 10, timeoutMs: 1000 },
  })
  onTestFinished(async () => { await Promise.all([local.close(), host.close()]) })
  let heartbeats = 0
  const twice = Promise.withResolvers<undefined>()
  client.on('message', (data) => {
    if ((JSON.parse(String(data)) as { kind: string }).kind === 'ping' && ++heartbeats === 2) twice.resolve(undefined)
  })
  await twice.promise
  expect(await host.invoke({ revision: 'r', service: 'files', name: 'read', args: {} }, 1000)).toEqual({ content: [] })
})

it('forwards one operation over real sockets and preserves its full MCP result', async () => {
  const { client, remote } = await openSockets()
  let operations = 0
  const generation = 'generation-1' as GenerationId
  const local = new ProxyChannel(client, { generation, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2, onInvoke: async (frame) => {
    operations++
    if (typeof frame.args.path !== 'string') throw new Error('Expected fixture file path')
    return { content: [{ type: 'text', text: frame.args.path }], structuredContent: { calls: operations }, _meta: { local: true } }
  } })
  const host = new ProxyChannel(remote, { generation, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2 })
  onTestFinished(async () => { await Promise.all([local.close(), host.close()]) })
  expect(await host.invoke({ revision: 'r', service: 'files', name: 'read', args: { path: 'project.txt' } }, 10000)).toEqual({ content: [{ type: 'text', text: 'project.txt' }], structuredContent: { calls: 1 }, _meta: { local: true } })
  expect(operations).toBe(1)
})

it('does not replay an operation after the socket closes during execution', async () => {
  const { client, remote } = await openSockets()
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let operations = 0
  const generation = 'g' as GenerationId
  const local = new ProxyChannel(client, { generation, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2, onInvoke: async () => {
    operations++
    started.resolve(undefined)
    await release.promise
    return { content: [] }
  } })
  const host = new ProxyChannel(remote, { generation, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2 })
  onTestFinished(async () => { release.resolve(undefined); await Promise.all([local.close(), host.close()]) })
  const call = host.invoke({ revision: 'r', service: 'files', name: 'write', args: {} }, 10000)
  const rejected = expect(call).rejects.toMatchObject({ code: 'unknown' })
  await started.promise
  client.terminate()
  await rejected
  release.resolve(undefined)
  await local.close()
  expect(operations).toBe(1)
})

it.each([4096, 161])('refuses local concurrency exhaustion with a %s-byte frame limit', async (maxFrameBytes) => {
  const { client, remote } = await openSockets()
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let operations = 0
  const generation = 'g' as GenerationId
  const local = new ProxyChannel(client, { generation, maxFrameBytes, maxInvocations: 10, maxPending: 1, onInvoke: async (frame) => {
    operations++
    if (frame.name === 'first') { started.resolve(undefined); await release.promise }
    return { content: [] }
  } })
  const host = new ProxyChannel(remote, { generation, maxFrameBytes, maxInvocations: 10, maxPending: 2 })
  onTestFinished(async () => { release.resolve(undefined); await Promise.all([local.close(), host.close()]) })
  const first = host.invoke({ revision: 'r', service: 'files', name: 'first', args: {} }, 10000)
    .then(value => ({ ok: true, value }), error => ({ ok: false, error }))
  try {
    await started.promise
    await expect(host.invoke({ revision: 'r', service: 'files', name: 'second', args: {} }, 10000)).rejects.toMatchObject({ code: 'unavailable' })
    expect(operations).toBe(1)
  } finally { release.resolve(undefined); expect(await first).toMatchObject({ ok: true }) }
})

it('returns a cached reply instead of executing a duplicate wire invocation', async () => {
  const { client, remote } = await openSockets()
  let calls = 0
  const local = new ProxyChannel(client, { generation: 'g' as GenerationId, maxFrameBytes: 4096, maxInvocations: 3, maxPending: 1, onInvoke: async () => {
    calls++
    return { content: [], structuredContent: { calls } }
  } })
  onTestFinished(async () => { await local.close() })
  const frame = JSON.stringify({ v: 1, kind: 'invoke', generation: 'g', id: 'same-call', revision: 'r', service: 'files', name: 'write', args: {}, timeoutMs: 10000 })
  const first = once(remote, 'message')
  remote.send(frame)
  const [one] = await first
  const repeated = once(remote, 'message')
  remote.send(frame)
  const [two] = await repeated
  expect(JSON.parse(String(two))).toEqual(JSON.parse(String(one)))
  expect(calls).toBe(1)
})

it('closes on a forged generation instead of accepting a result from another connection', async () => {
  const { client, remote } = await openSockets()
  const host = new ProxyChannel(remote, { generation: 'g' as GenerationId, maxFrameBytes: 4096, maxInvocations: 3, maxPending: 1 })
  onTestFinished(async () => { await host.close() })
  const received = once(client, 'message')
  const pending = host.invoke({ revision: 'r', service: 'files', name: 'read', args: {} }, 10000)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'unknown' })
  const [raw] = await received
  const frame = JSON.parse(String(raw)) as { id: string }
  client.send(JSON.stringify({ v: 1, kind: 'result', id: frame.id, generation: 'other', result: { content: [] } }))
  await rejected
})

it('does not dispatch an operation whose caller already cancelled', async () => {
  const { client, remote } = await openSockets()
  let calls = 0
  const generation = 'g' as GenerationId
  const local = new ProxyChannel(client, { generation, maxFrameBytes: 4096, maxInvocations: 3, maxPending: 1, onInvoke: async () => {
    calls++
    return { content: [] }
  } })
  const host = new ProxyChannel(remote, { generation, maxFrameBytes: 4096, maxInvocations: 3, maxPending: 1 })
  onTestFinished(async () => { await Promise.all([local.close(), host.close()]) })
  await expect(host.invoke({ revision: 'r', service: 'files', name: 'write', args: {} }, 10000, AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' })
  expect(calls).toBe(0)
})

it.each(['cancel', 'timeout'] as const)('propagates %s to a running local operation without accepting late success', async (mode) => {
  const { client, remote } = await openSockets()
  const started = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  let calls = 0
  const generation = 'g' as GenerationId
  const local = new ProxyChannel(client, { generation, maxFrameBytes: 4096, maxInvocations: 3, maxPending: 1,
    onInvoke: async (_frame, signal) => {
      calls++
      started.resolve(undefined)
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { aborted.resolve(undefined); resolve() }, { once: true })
      })
      return { content: [], structuredContent: { late: true } }
    } })
  const host = new ProxyChannel(remote, { generation, maxFrameBytes: 4096, maxInvocations: 3, maxPending: 1 })
  onTestFinished(async () => { await Promise.all([local.close(), host.close()]) })
  const controller = new AbortController()
  const pending = host.invoke({ revision: 'r', service: 'files', name: 'write', args: {} }, mode === 'timeout' ? 1000 : 10000, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'unknown' })
  await started.promise
  if (mode === 'cancel') controller.abort()
  await rejected
  await aborted.promise
  await local.close()
  expect(calls).toBe(1)
})

it.each(['throw', 'oversize'] as const)('reports %s execution failure without exposing raw provider data', async (mode) => {
  const { client, remote } = await openSockets()
  const generation = 'g' as GenerationId
  const local = new ProxyChannel(client, { generation, maxFrameBytes: 512, maxInvocations: 3, maxPending: 1, onInvoke: async () => {
    if (mode === 'throw') throw new Error('test-only-private-value')
    return { content: [{ type: 'text', text: 'x'.repeat(1024) }] }
  } })
  const host = new ProxyChannel(remote, { generation, maxFrameBytes: 512, maxInvocations: 3, maxPending: 1 })
  onTestFinished(async () => { await Promise.all([local.close(), host.close()]) })
  await expect(host.invoke({ revision: 'r', service: 'files', name: 'read', args: {} }, 10000)).rejects.toMatchObject({ code: 'failed', message: 'Local MCP invocation did not complete successfully' })
})
