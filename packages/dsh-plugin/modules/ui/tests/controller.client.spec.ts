import { expect, it, vi, onTestFinished } from 'vitest'
import { ProxyConnectionController } from '../src/client/controller.ts'

const config = { pollIntervalMs: 1, statusIntervalMs: 10000, associationTimeoutMs: 1000, requestTimeoutMs: 500, maxResponseBytes: 4096 }
const id = 'a'.repeat(43)

it('opens a versioned deployment URI and completes its browser association', async () => {
  const uri = `mcp-proxy://associate/${id}?v=2&origin=https%3A%2F%2Fdsh.example`
  const activate = vi.fn()
  const controller = new ProxyConnectionController(config, async url => url.endsWith('/begin')
    ? Response.json({ requestId: id, uri }) : url.endsWith('/finish') ? Response.json({ state: 'bound' })
      : Response.json({ state: 'connected', services: [{ service: 'files' }] }), activate)
  onTestFinished(() => controller.close())
  await controller.connect()
  expect(activate).toHaveBeenCalledExactlyOnceWith(uri)
  expect(controller.state.getSnapshot()).toMatchObject({ phase: 'connected', services: ['files'] })
})

it.each([
  `mcp-proxy://associate/${'b'.repeat(43)}?v=2&origin=https%3A%2F%2Fdsh.example`,
  `mcp-proxy://associate/${id}?v=2&origin=http%3A%2F%2Fdsh.example`,
  `mcp-proxy://associate/${id}?v=2&origin=https%3A%2F%2Fdsh.example&extra=1`,
])('does not launch a mismatched or malformed versioned URI %#', async (uri) => {
  const activate = vi.fn()
  const controller = new ProxyConnectionController(config, async () => Response.json({ requestId: id, uri }), activate)
  onTestFinished(() => controller.close())
  await controller.connect()
  expect(activate).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot().phase).toBe('unavailable')
})

it('refreshes a visible connection on its status interval and stops requests after unload', async () => {
  vi.useFakeTimers()
  let connected = false
  const fetch = vi.fn(async () => Response.json(connected ? { state: 'connected', services: [{ service: 'files' }] }
    : { state: 'unbound' }))
  const controller = new ProxyConnectionController({ ...config, statusIntervalMs: 10 }, fetch, () => {})
  onTestFinished(async () => { await controller.close(); vi.useRealTimers() })
  controller.start()
  controller.start()
  await controller.refresh()
  expect(fetch).toHaveBeenCalledTimes(1)
  connected = true
  await vi.advanceTimersByTimeAsync(10)
  expect(controller.state.getSnapshot()).toMatchObject({ phase: 'connected', services: ['files'] })
  await controller.close()
  const count = fetch.mock.calls.length
  await controller.refresh()
  await controller.connect()
  await controller.disconnect()
  await vi.advanceTimersByTimeAsync(100)
  expect(fetch).toHaveBeenCalledTimes(count)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not start polling when its owner was already closed', async () => {
  const fetch = vi.fn(async () => Response.json({ state: 'unbound' }))
  const controller = new ProxyConnectionController(config, fetch, () => {})
  await controller.close()
  controller.start()
  expect(fetch).not.toHaveBeenCalled()
})

it('ends an unconfirmed association at its deadline while a poll is waiting', async () => {
  vi.useFakeTimers()
  const controller = new ProxyConnectionController({ ...config, pollIntervalMs: 50, associationTimeoutMs: 5 },
    async url => url.endsWith('/begin') ? Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` })
      : Response.json({}, { status: 409 }), () => {})
  onTestFinished(async () => { await controller.close(); vi.useRealTimers() })
  const pending = controller.connect()
  await vi.advanceTimersByTimeAsync(5)
  await pending
  expect(controller.state.getSnapshot().phase).toBe('unavailable')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([{ status: 503, state: 'refused' }, { status: 200, state: 'not-bound' }])
('does not treat a failed association confirmation as pending or connected %#', async ({ status, state }) => {
  const controller = new ProxyConnectionController(config, async url => url.endsWith('/begin')
    ? Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` }) : Response.json({ state }, { status }), () => {})
  onTestFinished(() => controller.close())
  await controller.connect()
  expect(controller.state.getSnapshot().phase).toBe('unavailable')
})

it.each([
  { status: 401, value: {} },
  { status: 200, value: { state: 'unexpected' } },
  { status: 200, value: { state: 'connected', services: {} } },
  { status: 200, value: { state: 'connected', services: [null] } },
  { status: 200, value: { state: 'connected', services: [{ service: 1 }] } },
  { status: 200, value: { state: 'connected', services: [{ service: 'invalid alias' }] } },
])('does not present refused or malformed status metadata as a connection %#', async ({ status, value }) => {
  const controller = new ProxyConnectionController(config, async () => Response.json(value, { status }), () => {})
  onTestFinished(() => controller.close())
  const pending = controller.refresh()
  expect(controller.refresh()).toBe(pending)
  await pending
  expect(controller.state.getSnapshot()).toEqual({ phase: 'unavailable', services: [], uri: null })
})

it.each([{ status: 503, value: {} }, { status: 200, value: { state: 'connected' } }])
('reports an unsuccessful grant revocation without inventing an unbound state %#', async ({ status, value }) => {
  const controller = new ProxyConnectionController(config, async () => Response.json(value, { status }), () => {})
  onTestFinished(() => controller.close())
  const pending = controller.disconnect()
  expect(controller.disconnect()).toBe(pending)
  expect(controller.refresh()).toBe(pending)
  await pending
  expect(controller.state.getSnapshot().phase).toBe('unavailable')
})

it('waits for server confirmation across a polling delay and retains no deadline after completion', async () => {
  vi.useFakeTimers()
  let confirmations = 0
  const controller = new ProxyConnectionController(config, async (url) => {
    if (url.endsWith('/begin')) return Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` })
    if (url.endsWith('/finish')) return ++confirmations === 1 ? Response.json({}, { status: 409 })
      : Response.json({ state: 'bound' })
    return Response.json({ state: 'connected', services: [] })
  }, () => {})
  onTestFinished(async () => { await controller.close(); vi.useRealTimers() })
  const pending = controller.connect()
  await vi.advanceTimersByTimeAsync(0)
  expect(confirmations).toBe(1)
  expect(controller.state.getSnapshot().phase).toBe('waiting')
  await vi.advanceTimersByTimeAsync(config.pollIntervalMs)
  await pending
  expect(confirmations).toBe(2)
  expect(controller.state.getSnapshot()).toMatchObject({ phase: 'connected', services: [] })
  expect(vi.getTimerCount()).toBe(0)
})

it('reconnects only after an admitted revocation finishes', async () => {
  const entered = Promise.withResolvers<undefined>()
  const revoked = Promise.withResolvers<Response>()
  const requests: string[] = []
  const controller = new ProxyConnectionController(config, async (url) => {
    requests.push(url)
    if (url.endsWith('/revoke')) { entered.resolve(undefined); return revoked.promise }
    if (url.endsWith('/begin')) return Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` })
    if (url.endsWith('/finish')) return Response.json({ state: 'bound' })
    return Response.json({ state: 'connected', services: [] })
  }, () => {})
  onTestFinished(async () => { revoked.resolve(Response.json({ state: 'unbound' })); await controller.close() })
  const disconnect = controller.disconnect()
  await entered.promise
  const reconnect = controller.connect()
  expect(requests).toEqual(['/api/mcp-proxy/revoke'])
  revoked.resolve(Response.json({ state: 'unbound' }))
  await Promise.all([disconnect, reconnect])
  expect(requests).toEqual(['/api/mcp-proxy/revoke', '/api/mcp-proxy/begin', '/api/mcp-proxy/finish', '/api/mcp-proxy/status'])
})

it('opens only the validated local URI and waits for server confirmation before reporting connected', async () => {
  let release: (() => void) | undefined
  const finish = new Promise<Response>((resolve) => { release = () => { resolve(Response.json({ state: 'bound' })) } })
  const activate = vi.fn()
  const requests: string[] = []
  const controller = new ProxyConnectionController(config, async (url) => {
    requests.push(url)
    if (url.endsWith('/begin')) return Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` })
    if (url.endsWith('/finish')) return finish
    return Response.json({ state: 'connected', services: [{ service: 'files' }] })
  }, activate)
  onTestFinished(async () => { release?.(); await controller.close() })
  const action = controller.connect()
  expect(controller.connect()).toBe(action)
  await expect.poll(() => activate.mock.calls.length).toBe(1)
  expect(controller.state.getSnapshot().phase).toBe('waiting')
  release?.()
  await action
  expect(controller.state.getSnapshot()).toMatchObject({ phase: 'connected', services: ['files'] })
  expect(requests).toContain('/api/mcp-proxy/finish')
  await controller.close()
})

it('cancels a pending response reader when the UI plugin unloads', { timeout: 1000 }, async () => {
  const entered = Promise.withResolvers<undefined>()
  let writer: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancelled = false
  onTestFinished(() => { if (!cancelled) writer?.close() })
  const stream = new ReadableStream<Uint8Array>({
    start(value) { writer = value }, pull() { entered.resolve(undefined) }, cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const controller = new ProxyConnectionController(config, async url => url.endsWith('/begin')
    ? Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` }) : new Response(stream), () => {})
  const action = controller.connect()
  await entered.promise
  await controller.close()
  await action
  expect(cancelled).toBe(true)
})

it('refuses a server response which attempts to launch another URI', async () => {
  const activate = vi.fn()
  const controller = new ProxyConnectionController(config, async () => Response.json({ requestId: id, uri: 'https://other.example' }), activate)
  await controller.connect()
  expect(activate).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot().phase).toBe('unavailable')
  await controller.close()
})

it('does not let a late status read replace a newly confirmed association', async () => {
  const previous = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<undefined>()
  let reads = 0
  const controller = new ProxyConnectionController(config, async (url) => {
    if (url.endsWith('/begin')) return Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` })
    if (url.endsWith('/finish')) return Response.json({ state: 'bound' })
    if (++reads === 1) { entered.resolve(undefined); return previous.promise }
    return Response.json({ state: 'connected', services: [{ service: 'new' }] })
  }, () => {})
  onTestFinished(async () => { previous.resolve(Response.json({ state: 'unbound' })); await controller.close() })
  const reading = controller.refresh()
  await entered.promise
  await controller.connect()
  previous.resolve(Response.json({ state: 'connected', services: [{ service: 'old' }] }))
  await reading
  expect(controller.state.getSnapshot()).toMatchObject({ phase: 'connected', services: ['new'] })
})

it('cancels an unfinished association before revoking its browser grant', async () => {
  const entered = Promise.withResolvers<undefined>()
  const requests: string[] = []
  const controller = new ProxyConnectionController(config, async (url, init) => {
    requests.push(url)
    if (url.endsWith('/begin')) return Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` })
    if (url.endsWith('/revoke')) return Response.json({ state: 'unbound' })
    return new Promise<Response>((_resolve, reject) => {
      entered.resolve(undefined)
      const signal = init.signal
      if (signal?.aborted) reject(new Error('cancelled'))
      else signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
    })
  }, () => {})
  onTestFinished(async () => { await controller.close() })
  const action = controller.connect()
  await entered.promise
  await controller.disconnect()
  await action
  expect(requests.at(-1)).toBe('/api/mcp-proxy/revoke')
  expect(controller.state.getSnapshot().phase).toBe('unbound')
})

it('bounds response bytes before acting on association metadata', async () => {
  const activate = vi.fn()
  const controller = new ProxyConnectionController({ ...config, maxResponseBytes: 10 }, async () =>
    Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` }), activate)
  onTestFinished(async () => { await controller.close() })
  await controller.connect()
  expect(activate).not.toHaveBeenCalled()
  expect(controller.state.getSnapshot().phase).toBe('unavailable')
})

it('does not begin or activate a connection cancelled in the same turn of the event loop', async () => {
  const activate = vi.fn()
  const requests: string[] = []
  const controller = new ProxyConnectionController(config, async (url) => {
    requests.push(url)
    return url.endsWith('/begin') ? Response.json({ requestId: id, uri: `mcp-proxy://associate/${id}` })
      : Response.json({ state: 'unbound' })
  }, activate)
  onTestFinished(async () => { await controller.close() })
  const connecting = controller.connect()
  await controller.disconnect()
  await connecting
  expect(activate).not.toHaveBeenCalled()
  expect(requests).toEqual(['/api/mcp-proxy/revoke'])
  expect(controller.state.getSnapshot().phase).toBe('unbound')
})
