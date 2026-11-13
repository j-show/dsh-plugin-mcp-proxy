import { expect, it, onTestFinished } from 'vitest'
import { once } from 'node:events'
import { ProxyChannel } from '../src/channel.ts'
import type { GenerationId } from '../src/protocol.ts'
import { openSockets } from './helpers/sockets.ts'

it('returns a nested model response only to its live originating tool invocation', async () => {
  const { client, remote } = await openSockets()
  const limits = { generation: 'g' as GenerationId, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2 }
  const local: ProxyChannel = new ProxyChannel(client, { ...limits, onInvoke: async (frame, signal) => {
    const response = await local.callback(frame.id, 'sampling', { messages: [] }, 2000, signal)
    return { content: [], structuredContent: response }
  } })
  const host = new ProxyChannel(remote, limits)
  onTestFinished(async () => { await Promise.all([local.close(), host.close()]) })
  const received: unknown[] = []
  const result = await host.invoke({ revision: 'r', service: 'files', name: 'ask', args: {} }, 5000, undefined,
    async (request, signal) => {
      expect(signal.aborted).toBe(false)
      received.push(request.method)
      return { model: 'fixture', role: 'assistant', content: { type: 'text', text: 'nested answer' } }
    })
  expect(received).toEqual(['sampling'])
  expect(result.structuredContent).toMatchObject({ content: { text: 'nested answer' } })
})

it('aborts an admitted nested request when its parent invocation is cancelled', async () => {
  const { client, remote } = await openSockets()
  const limits = { generation: 'g' as GenerationId, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2 }
  const local = new ProxyChannel(client, { ...limits, onInvoke: async (frame, signal) => {
    await local.callback(frame.id, 'elicitation', { message: 'Choose' }, 5000, signal)
    return { content: [] }
  } })
  const host = new ProxyChannel(remote, limits)
  onTestFinished(async () => { await Promise.all([local.close(), host.close()]) })
  const entered = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const stop = new AbortController()
  const call = host.invoke({ revision: 'r', service: 'files', name: 'ask', args: {} }, 10000, stop.signal,
    async (_request, signal) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      stopped.resolve(undefined)
      throw new Error('cancelled')
    })
  const outcome = call.then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  stop.abort()
  expect(await outcome).toMatchObject({ error: { code: 'unknown' } })
  await stopped.promise
})

it('rejects callbacks outside a pending parent without invoking a model or human owner', async () => {
  const { client, remote } = await openSockets()
  const host = new ProxyChannel(remote, { generation: 'g' as GenerationId, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2 })
  onTestFinished(async () => { await host.close() })
  const response = once(client, 'message')
  client.send(JSON.stringify({ v: 1, kind: 'callback', id: 'nested', parent: 'unknown', generation: 'g',
    method: 'sampling', params: {},
  }))
  expect(JSON.parse(String((await response)[0]))).toMatchObject({ kind: 'callback-failure', code: 'unknown', parent: 'unknown' })
})

it('reuses an answered callback identity and rejects changed parameters without executing twice', async () => {
  const { client, remote } = await openSockets()
  const host = new ProxyChannel(remote, { generation: 'g' as GenerationId, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 2 })
  onTestFinished(async () => { await host.close() })
  let calls = 0
  const dispatched = once(client, 'message')
  const invocation = host.invoke({ revision: 'r', service: 'files', name: 'ask', args: {} }, 10000, undefined,
    async () => { calls++; return { action: 'accept' } })
  const outcome = invocation.then(value => ({ value }), (error: unknown) => ({ error }))
  const parent = (JSON.parse(String((await dispatched)[0])) as { id: string }).id
  const callback = { v: 1, kind: 'callback', id: 'same', parent, generation: 'g', method: 'elicitation', params: {} }
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = once(client, 'message')
    client.send(JSON.stringify(callback))
    expect(JSON.parse(String((await response)[0]))).toMatchObject({ kind: 'callback-result', response: { action: 'accept' } })
  }
  const conflict = once(client, 'message')
  client.send(JSON.stringify({ ...callback, params: { message: 'changed' } }))
  expect(JSON.parse(String((await conflict)[0]))).toMatchObject({ kind: 'callback-failure', code: 'failed' })
  expect(calls).toBe(1)
  client.terminate()
  expect(await outcome).toMatchObject({ error: { code: 'unknown' } })
})

it('retains a capacity refusal when the same callback is delivered after an execution slot frees', async () => {
  const { client, remote } = await openSockets()
  const host = new ProxyChannel(remote, { generation: 'g' as GenerationId, maxFrameBytes: 4096, maxInvocations: 10, maxPending: 1 })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); await host.close() })
  const calls: string[] = []
  const dispatched = once(client, 'message')
  const invocation = host.invoke({ revision: 'r', service: 'files', name: 'ask', args: {} }, 10000, undefined,
    async (request) => { calls.push(request.id); entered.resolve(undefined); await release.promise; return { action: 'accept' } })
  const outcome = invocation.then(value => ({ value }), (error: unknown) => ({ error }))
  const parent = (JSON.parse(String((await dispatched)[0])) as { id: string }).id
  const callback = { v: 1, kind: 'callback', parent, generation: 'g', method: 'elicitation', params: {} }
  client.send(JSON.stringify({ ...callback, id: 'A' }))
  await entered.promise
  const refused = once(client, 'message')
  client.send(JSON.stringify({ ...callback, id: 'B' }))
  expect(JSON.parse(String((await refused)[0]))).toMatchObject({ id: 'B', kind: 'callback-failure' })
  const answered = once(client, 'message')
  release.resolve(undefined)
  expect(JSON.parse(String((await answered)[0]))).toMatchObject({ id: 'A', kind: 'callback-result' })
  const repeated = once(client, 'message')
  client.send(JSON.stringify({ ...callback, id: 'B' }))
  expect(JSON.parse(String((await repeated)[0]))).toMatchObject({ id: 'B', kind: 'callback-failure' })
  expect(calls).toEqual(['A'])
  client.terminate()
  await outcome
})
