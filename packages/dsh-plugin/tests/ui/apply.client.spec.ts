/** Client Loader ownership: deployment budgets, localized slots and retained Session requests. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime, SlotRegistry } from './support/framework.ts'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, vi, onTestFinished } from 'vitest'
import { apply, inject } from '../../src/client/index.ts'
import type { ConnectionInjected } from '../../src/client/ConnectionSection.tsx'
import type { ElicitationInjected } from '../../src/client/ElicitationDock.tsx'
import { en, zh } from '../../src/client/locales.ts'

const config = { pollIntervalMs: 500, statusIntervalMs: 15000,
  associationTimeoutMs: 30000, requestTimeoutMs: 10000, maxResponseBytes: 65536 }
const sessionId = 'client-session' as SessionId
const transaction = 'a'.repeat(43)
const waitId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); vi.unstubAllGlobals() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return { ctx, locale, slots: ctx.get('slots') as SlotRegistry }
}

function declare(slots: SlotRegistry): void {
  slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
  } } as never, () => null)
}

it('registers localized connection and Session slots and delegates their actions using Host budgets', async () => {
  const b = await bench()
  const activate = vi.fn()
  vi.stubGlobal('window', { location: { assign: activate } })
  let connected = false
  let answered = false
  const requests: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    requests.push({ url, body })
    if (url.endsWith('/ui-config')) return Response.json({ ...config, maxResponseBytes: 4096 })
    if (url.endsWith('/begin')) return Response.json({ requestId: transaction, uri: `mcp-proxy://associate/${transaction}` })
    if (url.endsWith('/finish')) { connected = true; return Response.json({ state: 'bound' }) }
    if (url.endsWith('/revoke')) { connected = false; return Response.json({ state: 'unbound' }) }
    if (url.endsWith('/pending')) return Response.json({ pending: answered ? null : { id: waitId, sessionId, expiresAt: 9999999999999,
      params: { mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    } })
    if (url.endsWith('/respond')) { answered = true; return Response.json({ state: 'answered' }) }
    return Response.json(connected ? { state: 'connected', services: [{ service: 'files' }] } : { state: 'unbound' })
  })
  const fiber = b.ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  const unrelated = b.ctx.plugin({ name: 'unrelated-client-feature', apply() {} })
  await unrelated.await()
  await unrelated.dispose()
  expect(b.slots.entries('settings.section')).toHaveLength(0)
  declare(b.slots)
  await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
  const settings = b.slots.entries('settings.section')[0]!
  const connection = (settings.inject as unknown as () => ConnectionInjected)()
  b.locale.setLocale('en')
  expect(resolveSlotLabel(settings.options.label)).toBe(en.nav)
  b.locale.setLocale('zh')
  expect(resolveSlotLabel(settings.options.label)).toBe(zh.nav)
  await connection.connect()
  expect(activate).toHaveBeenCalledWith(`mcp-proxy://associate/${transaction}`)
  await connection.refresh()
  expect(connection.hooks.mcpProxyConnection.getSnapshot()).toMatchObject({ phase: 'connected', services: ['files'] })
  const dock = b.slots.entries('conversation.input.dock')[0]!
  const elicitation = (dock.inject as unknown as (id: SessionId) => ElicitationInjected)(sessionId)
  const detach = elicitation.hooks.mcpProxyElicitation.subscribe(() => {})
  await elicitation.refreshElicitation()
  const pending = elicitation.hooks.mcpProxyElicitation.getSnapshot().pending
  if (pending === null) throw new Error('Expected retained Session request')
  await elicitation.answer(pending.id, 'accept', { name: 'Ada' })
  expect(requests.find(request => request.url.endsWith('/respond'))?.body).toEqual({ sessionId, id: waitId,
    response: { action: 'accept', content: { name: 'Ada' } },
  })
  expect(elicitation.hooks.mcpProxyElicitation.getSnapshot().pending).toBeNull()
  detach()
  await connection.disconnect()
  expect(connection.hooks.mcpProxyConnection.getSnapshot().phase).toBe('unbound')
  await fiber.dispose()
  expect(b.slots.entries('settings.section')).toHaveLength(0)
  expect(b.slots.entries('conversation.input.dock')).toHaveLength(0)
  expect(() => b.locale.register('mcp-proxy', 'en', {})).not.toThrow()
})

it('retains a manual URI while browser activation is unavailable and confirmation is pending', async () => {
  const b = await bench()
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/ui-config')) return Response.json(config)
    if (url.endsWith('/begin')) return Response.json({ requestId: transaction, uri: `mcp-proxy://associate/${transaction}` })
    if (url.endsWith('/finish')) return Response.json({ state: 'pending' }, { status: 409 })
    return Response.json({ state: 'unbound' })
  })
  declare(b.slots)
  const fiber = b.ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  const settings = b.slots.entries('settings.section')[0]!
  const connection = (settings.inject as unknown as () => ConnectionInjected)()
  const action = connection.connect()
  await expect.poll(() => connection.hooks.mcpProxyConnection.getSnapshot().phase).toBe('waiting')
  expect(connection.hooks.mcpProxyConnection.getSnapshot().uri).toBe(`mcp-proxy://associate/${transaction}`)
  await fiber.dispose()
  await action
})

it('aborts the configuration request when its Loader owner unloads before registration', async () => {
  const b = await bench()
  const entered = Promise.withResolvers<undefined>()
  let requestSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    requestSignal = init.signal ?? undefined
    entered.resolve(undefined)
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('Aborted fixture request')) }, { once: true })
    })
  })
  const fiber = b.ctx.plugin({ inject: [...inject], apply }, config)
  const settled = fiber.await().catch((error: unknown) => error)
  await entered.promise
  await fiber.dispose()
  await settled
  expect(requestSignal?.aborted).toBe(true)
  expect(b.slots.entries('settings.section')).toHaveLength(0)
})

it('refuses Host configuration failures before registering interactive slots', async () => {
  const b = await bench()
  vi.stubGlobal('fetch', async () => new Response('not available', { status: 503 }))
  await expect(apply(b.ctx, config)).rejects.toThrow('MCP proxy UI configuration unavailable')
  expect(b.slots.entries('settings.section')).toHaveLength(0)
})

it('joins an unsubscribed request reader before finishing plugin disposal', async () => {
  const b = await bench()
  const reading = Promise.withResolvers<undefined>()
  const cancelling = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  onTestFinished(() => { released.resolve(undefined) })
  const body = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(undefined) },
    cancel() { cancelling.resolve(undefined); return released.promise },
  }, { highWaterMark: 0 })
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.endsWith('/ui-config')) return Response.json(config)
    if (url.endsWith('/pending')) return new Response(body)
    return Response.json({ state: 'unbound' })
  })
  declare(b.slots)
  const fiber = b.ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  const dock = b.slots.entries('conversation.input.dock')[0]!
  const elicitation = (dock.inject as unknown as (id: SessionId) => ElicitationInjected)(sessionId)
  const detach = elicitation.hooks.mcpProxyElicitation.subscribe(() => {})
  await reading.promise
  detach()
  await cancelling.promise
  let disposed = false
  const closing = fiber.dispose().then(() => { disposed = true })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  expect(disposed).toBe(false)
  released.resolve(undefined)
  await closing
  expect(disposed).toBe(true)
  expect(body.locked).toBe(false)
})
