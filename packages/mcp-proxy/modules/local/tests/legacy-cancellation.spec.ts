import { expect, it } from 'vitest'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { InvocationId } from '@jshow/app-mcp-proxy/protocol'
import { LegacyCancellation } from '../src/legacy-cancellation.ts'

const parentId = 'parent-call' as InvocationId

it('executes duplicate pending callback ID zero once and returns the same response', async () => {
  const owner = new LegacyCancellation(8, 4096)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let calls = 0
  const first = owner.run(0, new AbortController().signal, async () => {
    calls++
    entered.resolve(undefined)
    await release.promise
    return { text: 'first' }
  }, 'sampling', parentId)
  const repeated = owner.run(0, new AbortController().signal, async () => { calls++; return { text: 'replayed' } }, 'sampling', parentId)
  try {
    await entered.promise
    expect(calls).toBe(1)
  } finally { release.resolve(undefined); await Promise.allSettled([first, repeated]) }
  expect(await first).toEqual({ text: 'first' })
  expect(await repeated).toEqual({ text: 'first' })
})

it('retains a detached terminal response without rerunning or changing the request method', async () => {
  const owner = new LegacyCancellation(1, 4096)
  let calls = 0
  const execute = async () => { calls++; return { text: 'original' } }
  const first = await owner.run(0, new AbortController().signal, execute, 'sampling', parentId)
  const mutable = first as { text: string }
  mutable.text = 'changed by caller'
  expect(await owner.run(0, new AbortController().signal, execute, 'sampling', parentId)).toEqual({ text: 'original' })
  expect(calls).toBe(1)
  await expect(owner.run(0, new AbortController().signal, execute, 'elicitation', parentId)).rejects.toThrow('Conflicting')
  await expect(owner.run(1, new AbortController().signal, execute, 'sampling', parentId)).rejects.toThrow('capacity')
  expect(calls).toBe(1)
})

it('cancels the original pending zero-ID callback rather than leaving a duplicate alive', async () => {
  const owner = new LegacyCancellation(8, 4096)
  const base: Transport = { start: async () => {}, send: async () => {}, close: async () => {} }
  const transport = owner.wrap(base)
  await transport.start()
  const parents = [new AbortController(), new AbortController()] as const
  const entered = Promise.withResolvers<undefined>()
  const signals: AbortSignal[] = []
  const execute = async (signal: AbortSignal) => {
    signals.push(signal)
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    return { cancelled: true }
  }
  const first = owner.run(0, parents[0].signal, execute, 'sampling', parentId)
  const repeated = owner.run(0, parents[1].signal, execute, 'sampling', parentId)
  const observed = Promise.allSettled([first, repeated])
  try {
    await entered.promise
    base.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 0 } })
    expect(signals[0]?.aborted).toBe(true)
    expect(signals).toHaveLength(1)
  } finally {
    for (const parent of parents) parent.abort()
    await transport.close()
    await observed
  }
})

it('bounds complete cached response bytes and never includes the payload in its diagnostic', async () => {
  const owner = new LegacyCancellation(1, 64)
  await expect(owner.run(0, new AbortController().signal, async () => ({ text: 'private-test-value'.repeat(30) }), 'sampling', parentId))
    .rejects.toThrow(/^Local MCP callback response exceeds limit$/)
})

it('does not reuse another parent invocation response when a stateless peer starts its IDs at zero', async () => {
  const owner = new LegacyCancellation(8, 4096)
  expect(await owner.run(0, new AbortController().signal, async () => ({ text: 'first' }), 'sampling', parentId)).toEqual({ text: 'first' })
  expect(await owner.run(0, new AbortController().signal, async () => ({ text: 'second' }), 'sampling', 'other-call' as InvocationId)).toEqual({ text: 'second' })
})
