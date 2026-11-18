import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import { decodeFrame, type ProxyFrame } from '@jshow/app-mcp-proxy/protocol'
import { promptAdmissionId } from '../../src/host/index.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { openHost } from '../host/helpers/composition.ts'
import * as Controller from '../../src/browser/index.ts'

async function boot(config: Partial<Controller.Config> = {}) {
  const fixture = await openHost(4, [
    { name: '@deepseek-ai/dsh-client-connection', module: Connection, config: origin => ({ trustedHosts: [new URL(origin).host] }) },
    { name: '../../src/browser/index.ts', module: Controller, config: () => ({ maxRequestBytes: 256, ...config }) },
  ])
  function browser() {
    const jar = new Map<string, string>()
    const url = fixture.ctx.connection.authenticatedUrl(fixture.origin)
    fixture.ctx.connection.authorizeIndex({ method: 'GET', url, headers: { host: new URL(fixture.origin).host } }, {
      writeHead(_status, headers) {
        const cookie = headers?.['set-cookie']?.split(';')[0]
        if (cookie !== undefined) jar.set(cookie.slice(0, cookie.indexOf('=')), cookie)
      }, end() {},
    })
    async function request(route: string, body: unknown = {}, authenticated = true) {
      const response = await new Promise<Response>((resolve, reject) => {
        const request = httpRequest(`http://127.0.0.1:${fixture.ctx.webServer.port}/api/mcp-proxy/${route}`, {
          method: 'POST', headers: { Host: new URL(fixture.origin).host, Origin: fixture.origin,
            'Content-Type': 'application/json', ...(authenticated ? { Cookie: [...jar.values()].join('; ') } : {}),
          },
        }, (incoming) => {
          void (async () => {
            const chunks: Buffer[] = []
            for await (const chunk of incoming) chunks.push(chunk as Buffer)
            const headers = new Headers()
            for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
              headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!)
            }
            if (incoming.statusCode === undefined) throw new Error('Expected HTTP response status')
            resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }))
          })().catch(reject)
        })
        request.on('error', reject)
        request.end(JSON.stringify(body))
      })
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0]
        if (pair !== undefined) {
          const name = pair.slice(0, pair.indexOf('='))
          if (/Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name)
          else jar.set(name, pair)
        }
      }
      return response
    }
    return { jar, request }
  }
  async function ready() {
    const local = await fixture.local()
    const accepted = once(local.socket, 'message')
    local.socket.send(JSON.stringify({ v: 1, kind: 'catalog', revision: 'r1', services: [{ service: 'files' }],
      tools: [{ service: 'files', name: 'read', inputSchema: { type: 'object' } }],
    }))
    expect(decodeFrame(String((await accepted)[0]), 65536).kind).toBe('catalog-accepted')
    return local
  }
  return { ...fixture, browser, ready }
}

async function begin(browser: ReturnType<Awaited<ReturnType<typeof boot>>['browser']>) {
  const existing = [...browser.jar.keys()].some(name => name.startsWith('__Host-mcp-proxy-browser-'))
  const response = await browser.request('begin')
  expect(response.status).toBe(200)
  const issued = response.headers.get('set-cookie')
  if (issued === null) expect(existing).toBe(true)
  else expect(issued).toMatch(/HttpOnly/)
  return await response.json() as { requestId: string; uri: string }
}

it('bounds concurrent bound prompts and releases the admission slot when delegation settles', async () => {
  const fixture = await boot({ maxPromptRequests: 1 })
  const local = await fixture.ready()
  const browser = fixture.browser()
  const transaction = await begin(browser)
  local.socket.send(JSON.stringify({ v: 1, kind: 'association', requestId: transaction.requestId }))
  const confirmed = once(local.socket, 'message')
  local.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  await confirmed
  expect((await browser.request('finish', { requestId: transaction.requestId })).status).toBe(200)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let calls = 0
  fixture.ctx.effect(() => fixture.ctx.connection.rpc.intercept('/api', () => true, async () => {
    calls++
    entered.resolve(undefined)
    await release.promise
    return { ok: true, value: {} }
  }))
  const prompt = (requestId: string) => ({ type: 'client-request', rpcId: requestId, method: 'session/prompt',
    payload: { args: { request: { sessionId: 'session', requestId, content: [] } } },
  })
  const first = browser.request('../session/prompt', prompt('first'))
  await entered.promise
  const refused = await browser.request('../session/prompt', prompt('second'))
  expect(refused.status).toBe(503)
  expect(refused.headers.get('set-cookie')).toBeNull()
  expect(calls).toBe(1)
  release.resolve(undefined)
  expect((await first).status).toBe(200)
  expect((await browser.request('../session/prompt', prompt('third'))).status).toBe(200)
  expect(calls).toBe(2)
  local.socket.terminate()
  await expect.poll(() => fixture.ctx.mcpProxy.select(local.identity.endpointId)).toBeUndefined()
  expect((await browser.request('../session/prompt', prompt('disconnected'))).status).toBe(409)
  expect(calls).toBe(2)
})

it('returns an empty pending view and refuses an answer for an already-absent request', async () => {
  const fixture = await boot()
  const browser = fixture.browser()
  expect(await (await browser.request('elicitation/pending', { sessionId: 'session' })).json()).toEqual({ pending: null })
  expect((await browser.request('elicitation/respond', { sessionId: 'session',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', response: { action: 'cancel' },
  })).status).toBe(409)
  expect((await browser.request('elicitation/respond', { sessionId: 'session', id: 1, response: {} })).status).toBe(400)
})

it('refuses a Fetch callback retained by its carrier after the controller owner unloads', async () => {
  const getter = Object.getOwnPropertyDescriptor(Connection.HostConnectionService.prototype, 'fetch')?.get
  if (getter === undefined) throw new Error('Expected public Fetch registry getter')
  const captured = new Map<string, Connection.ConnectionFetchRoute['fetch']>()
  const spy = vi.spyOn(Connection.HostConnectionService.prototype, 'fetch', 'get').mockImplementation(function (
    this: Connection.HostConnectionService,
  ) {
    const registry = getter.call(this) as Connection.HostConnectionFetch
    return { register: (route) => {
      captured.set(route.path, route.fetch)
      return registry.register(route)
    } }
  })
  onTestFinished(() => { spy.mockRestore() })
  const fixture = await boot()
  spy.mockRestore()
  const callback = captured.get('/api/mcp-proxy/begin')
  if (callback === undefined) throw new Error('Expected captured Fetch callback')
  const unauthenticated = await callback(new Request(fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', body: '{}' }))
  expect(unauthenticated.status).toBe(401)
  expect(unauthenticated.headers.get('set-cookie')).toBeNull()
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '../../src/browser/index.ts')?.fiber
  if (fiber === undefined) throw new Error('Expected controller owner')
  await fiber.dispose()
  expect((await fixture.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
    fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', body: '{}' },
  ))).status).toBe(404)
  const result = await callback(new Request(fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', body: '{}' }))
  expect(result.status).toBe(503)
  expect(await result.json()).toEqual({ error: 'mcp-proxy-association-unavailable' })
  expect(result.headers.get('set-cookie')).toBeNull()
})

it.each(['expired', 'unsafe-expiry', 'nonce', 'signature', 'missing-signature'] as const)
('refuses a %s browser nonce without preventing revocation with the original verified cookie', async (mutation) => {
  const fixture = await boot()
  const browser = fixture.browser()
  await begin(browser)
  const nonce = [...browser.jar].find(([name]) => name.startsWith('__Host-mcp-proxy-browser-'))
  if (nonce === undefined) throw new Error('Expected browser nonce')
  const parts = nonce[1].slice(nonce[0].length + 1).split('.')
  if (mutation === 'expired') parts[1] = '1'
  else if (mutation === 'unsafe-expiry') parts[1] = '9999999999999999'
  else if (mutation === 'nonce') parts[0] = '!'.repeat(43)
  else if (mutation === 'signature') parts[2] = (parts[2]?.startsWith('a') ? 'b' : 'a') + parts[2]?.slice(1)
  else parts.pop()
  browser.jar.set(nonce[0], `${nonce[0]}=${parts.join('.')}`)
  const refused = await browser.request('revoke')
  expect(refused.status).toBe(409)
  expect(refused.headers.get('set-cookie')).toBeNull()
  browser.jar.set(...nonce)
  expect((await browser.request('revoke')).status).toBe(200)
})

it('refuses an expired correctly signed browser nonce while its login cookie remains valid', async () => {
  const fixture = await boot({ browserLifetimeMs: 10000 })
  const browser = fixture.browser()
  await begin(browser)
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10001)
  onTestFinished(() => { clock.mockRestore() })
  const expired = await browser.request('revoke')
  expect(expired.status).toBe(409)
  expect(expired.headers.get('set-cookie')).toBeNull()
  clock.mockRestore()
  expect((await browser.request('revoke')).status).toBe(200)
})

it('refuses a prompt whose captured middleware resumes after the owning plugin unloaded', async () => {
  const fixture = await boot()
  const local = await fixture.ready()
  const browser = fixture.browser()
  const transaction = await begin(browser)
  local.socket.send(JSON.stringify({ v: 1, kind: 'association', requestId: transaction.requestId }))
  const confirmed = once(local.socket, 'message')
  local.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  await confirmed
  expect((await browser.request('finish', { requestId: transaction.requestId })).status).toBe(200)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  fixture.ctx.on('connection/request', async (request, _response, next) => {
    if (request.url === '/api/session/prompt') { entered.resolve(undefined); await release.promise }
    await next()
  }, { prepend: true })
  let dispatched = false
  fixture.ctx.effect(() => fixture.ctx.connection.rpc.intercept('/api', () => true, async () => {
    dispatched = true
    return { ok: true, value: {} }
  }))
  const request = browser.request('../session/prompt', { type: 'client-request', rpcId: 'wire', method: 'session/prompt',
    payload: { args: { request: { sessionId: 'session', requestId: 'request', content: [] } } },
  })
  await entered.promise
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '../../src/browser/index.ts')?.fiber
  if (fiber === undefined) throw new Error('Expected controller owner')
  await fiber.dispose()
  release.resolve(undefined)
  expect((await request).status).toBe(503)
  expect(dispatched).toBe(false)
})

it.each([
  'broken-cookie', '=missing-name', 'duplicate=one; duplicate=two',
  'large=' + 'x'.repeat(9000),
  Array.from({ length: 70 }, (_, index) => `cookie${index}=value`).join('; '),
])('refuses malformed or excessive association cookies %# without issuing replacement authority', async (cookie) => {
  const fixture = await boot()
  const browser = fixture.browser()
  browser.jar.set('wire-fixture', cookie)
  const response = await browser.request('begin')
  expect(response.status).toBe(400)
  expect(response.headers.get('set-cookie')).toBeNull()
  browser.jar.delete('wire-fixture')
  expect(await (await browser.request('status')).json()).toEqual({ state: 'unbound' })
})

it('requires a fresh association after a browser nonce is tampered with', async () => {
  const fixture = await boot()
  const local = await fixture.ready()
  const browser = fixture.browser()
  const transaction = await begin(browser)
  local.socket.send(JSON.stringify({ v: 1, kind: 'association', requestId: transaction.requestId }))
  const acknowledged = once(local.socket, 'message')
  local.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  await acknowledged
  const nonce = [...browser.jar].find(([name]) => name.startsWith('__Host-mcp-proxy-browser-'))
  if (nonce === undefined) throw new Error('Expected browser nonce')
  browser.jar.set(nonce[0], nonce[1] + 'tampered')
  expect((await browser.request('finish', { requestId: transaction.requestId })).status).toBe(409)
  const renewed = await browser.request('begin')
  expect(renewed.status).toBe(200)
  expect(renewed.headers.get('set-cookie')).toMatch(/HttpOnly/)
  expect((await browser.request('finish', { requestId: transaction.requestId })).status).toBe(409)
})

it.each([undefined, '{private-invalid-json'])('refuses an absent or malformed JSON body without exposing it %#', async (body) => {
  const fixture = await boot()
  const browser = fixture.browser()
  const response = await fixture.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
    fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', headers: { Cookie: [...browser.jar.values()].join('; ') }, body: body ?? null },
  ))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'mcp-proxy-association-unavailable' })
  expect(response.headers.get('set-cookie')).toBeNull()
})

it.each([false, true])('settles request cancellation even if the body carrier refuses cancellation, already aborted=%s', async (alreadyAborted) => {
  const fixture = await boot()
  const browser = fixture.browser()
  const entered = Promise.withResolvers<undefined>()
  const stop = new AbortController()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull() { entered.resolve(undefined) },
    cancel() { cancelled = true; throw new Error('private-carrier-cancellation-error') },
  }, { highWaterMark: 0 })
  if (alreadyAborted) stop.abort()
  const response = fixture.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
    fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', headers: { Cookie: [...browser.jar.values()].join('; ') },
      body: stream, signal: stop.signal, duplex: 'half',
    } as RequestInit & { duplex: 'half' },
  ))
  if (!alreadyAborted) { await entered.promise; stop.abort() }
  const result = await response
  expect(result.status).toBe(503)
  expect(await result.json()).toEqual({ error: 'mcp-proxy-association-unavailable' })
  expect(cancelled).toBe(true)
  expect(stream.locked).toBe(false)
  expect(result.headers.get('set-cookie')).toBeNull()
})

it.each([
  { route: 'begin', body: null, status: 400 },
  { route: 'begin', body: [], status: 400 },
  { route: 'begin', body: { endpointId: 'browser-chosen-device' }, status: 400 },
  { route: 'begin', body: { value: 'x'.repeat(512) }, status: 413 },
  { route: 'status', body: { extra: true }, status: 400 },
  { route: 'revoke', body: { extra: true }, status: 400 },
  { route: 'finish', body: {}, status: 400 },
  { route: 'finish', body: { requestId: 1 }, status: 400 },
  { route: 'finish', body: { requestId: 'invalid' }, status: 400 },
  { route: 'elicitation/pending', body: {}, status: 400 },
  { route: 'elicitation/pending', body: { sessionId: '../other' }, status: 400 },
  { route: 'elicitation/pending', body: { sessionId: 'session', extra: true }, status: 400 },
  { route: 'elicitation/respond', body: { sessionId: 'session', id: 'invalid', response: {} }, status: 400 },
  { route: 'elicitation/respond', body: { sessionId: 'session', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', response: null }, status: 400 },
  { route: 'elicitation/respond', body: { sessionId: 'session', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', response: [] }, status: 400 },
])('rejects malformed $route input before creating browser authority %#', async ({ route, body, status }) => {
  const fixture = await boot()
  const browser = fixture.browser()
  const previousCookies = [...browser.jar]
  const response = await browser.request(route, body)
  expect(response.status).toBe(status)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect([...browser.jar]).toEqual(previousCookies)
  expect(await (await browser.request('status')).json()).toEqual({ state: 'unbound' })
})

it('lets a reopened authenticated browser answer a server-owned Session request without device selection', async () => {
  const fixture = await boot()
  const sessionId = SessionId('session-elicitation')
  const waiting = fixture.ctx.mcpProxy.elicitations.ask(sessionId, { mode: 'form', message: 'Your name?',
    requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  }, new AbortController().signal, () => {})
  const outcome = waiting.then(value => ({ value }), (error: unknown) => ({ error }))
  const original = fixture.browser()
  expect((await original.request('elicitation/pending', { sessionId }, false)).status).toBe(401)
  expect((await original.request('elicitation/pending', { sessionId })).status).toBe(200)
  const reopened = fixture.browser()
  const pending = await (await reopened.request('elicitation/pending', { sessionId })).json() as { pending: { id: string } }
  expect((await reopened.request('elicitation/respond', { sessionId, id: pending.pending.id,
    response: { action: 'accept', content: { name: 42 } },
  })).status).toBe(409)
  expect((await reopened.request('elicitation/respond', { sessionId, id: pending.pending.id,
    response: { action: 'accept', content: { name: 'Ada' } },
  })).status).toBe(200)
  expect(await outcome).toMatchObject({ value: { action: 'accept', content: { name: 'Ada' } } })
})

it('binds an authenticated browser to a device registered before any Session exists', async () => {
  const fixture = await boot()
  const local = await fixture.ready()
  const browser = fixture.browser()
  const request = await begin(browser)
  expect(request.uri).toBe(`mcp-proxy://associate/${request.requestId}`)
  expect((await browser.request('finish', { requestId: request.requestId })).status).toBe(409)
  const transaction: ProxyFrame = { v: 1, kind: 'association', requestId: request.requestId as Extract<ProxyFrame, { kind: 'association' }>['requestId'] }
  local.socket.send(JSON.stringify(transaction))
  const pong = once(local.socket, 'message')
  local.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  await pong
  const finished = await browser.request('finish', { requestId: request.requestId })
  expect(finished.status).toBe(200)
  expect((await browser.request('begin', { endpointId: 'replacement' })).status).toBe(400)
  expect(finished.headers.get('set-cookie')).toMatch(/Secure.*HttpOnly|HttpOnly.*Secure/)
  const status = await browser.request('status')
  expect(status.headers.get('set-cookie')).toMatch(/Secure.*HttpOnly|HttpOnly.*Secure/)
  expect(status.headers.get('set-cookie')?.split(';')[0]).toBe(finished.headers.get('set-cookie')?.split(';')[0])
  expect(await status.json()).toMatchObject({ state: 'connected', services: [{ service: 'files' }] })
  expect((await browser.request('finish', { requestId: request.requestId })).status).toBe(409)
  expect((await browser.request('revoke')).status).toBe(200)
  expect(await (await browser.request('status')).json()).toEqual({ state: 'unbound' })
})

it('does not let another authenticated browser finish or use the first browser association', async () => {
  const fixture = await boot()
  const local = await fixture.ready()
  const first = fixture.browser()
  const second = fixture.browser()
  const request = await begin(first)
  await begin(second)
  local.socket.send(JSON.stringify({ v: 1, kind: 'association', requestId: request.requestId }))
  const pong = once(local.socket, 'message')
  local.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  await pong
  expect((await second.request('finish', { requestId: request.requestId })).status).toBe(409)
  expect((await first.request('finish', { requestId: request.requestId })).status).toBe(200)
  const grant = [...first.jar.entries()].find(([name]) => name.includes('-grant-'))
  expect(grant).toBeDefined()
  if (grant === undefined) throw new Error('Expected association grant cookie')
  second.jar.set(...grant)
  expect((await second.request('status')).status).toBe(409)
})

it('rejects a delayed old grant cookie after the browser associates with another endpoint', async () => {
  const fixture = await boot()
  const first = await fixture.ready()
  const second = await fixture.ready()
  const browser = fixture.browser()
  const associate = async (local: typeof first) => {
    const request = await begin(browser)
    local.socket.send(JSON.stringify({ v: 1, kind: 'association', requestId: request.requestId }))
    const pong = once(local.socket, 'message')
    local.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
    await pong
    const finished = await browser.request('finish', { requestId: request.requestId })
    expect(finished.status).toBe(200)
  }
  await associate(first)
  const oldStatus = await browser.request('status')
  const oldPair = oldStatus.headers.get('set-cookie')?.split(';')[0]
  if (oldPair === undefined) throw new Error('Expected renewable old grant cookie')
  await associate(second)
  const current = [...browser.jar].find(([name]) => name.includes('-grant-'))
  if (current === undefined) throw new Error('Expected replacement grant')
  expect(current[1]).not.toBe(oldPair)
  browser.jar.set(current[0], oldPair)
  expect((await browser.request('status')).status).toBe(409)
  expect((await browser.request('../session/prompt', { type: 'client-request', rpcId: 'stale-cookie', method: 'session/prompt',
    payload: { args: { request: { sessionId: 'session', requestId: 'request', content: ['original content'] } } },
  })).status).toBe(409)
  browser.jar.set(current[0], current[1])
  expect(await (await browser.request('status')).json()).toMatchObject({ state: 'connected', endpointId: second.identity.endpointId })
})

it('keeps browser authentication and bounded JSON admission on association routes', async () => {
  const fixture = await boot()
  const browser = fixture.browser()
  expect((await browser.request('begin', {}, false)).status).toBe(401)
  expect((await browser.request('finish', { requestId: 'x'.repeat(300) })).status).toBe(413)
  expect((await browser.request('finish', { endpointId: 'unverified-browser-claim' })).status).toBe(400)
})

it('acknowledges revocation when this authenticated browser has not started an association', async () => {
  const fixture = await boot()
  const browser = fixture.browser()
  expect((await browser.request('revoke')).status).toBe(200)
  expect((await browser.request('revoke')).status).toBe(200)
})

it('reports the associated device unavailable without substituting another device with identical tools', async () => {
  const fixture = await boot()
  const first = await fixture.ready()
  const second = await fixture.ready()
  const browser = fixture.browser()
  const request = await begin(browser)
  first.socket.send(JSON.stringify({ v: 1, kind: 'association', requestId: request.requestId }))
  const pong = once(first.socket, 'message')
  first.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  await pong
  expect((await browser.request('finish', { requestId: request.requestId })).status).toBe(200)
  first.socket.terminate()
  await expect.poll(() => fixture.ctx.mcpProxy.select(first.identity.endpointId)).toBeUndefined()
  expect(fixture.ctx.mcpProxy.select(second.identity.endpointId)).toBeDefined()
  expect(await (await browser.request('status')).json()).toMatchObject({ state: 'unavailable', endpointId: first.identity.endpointId })
})

it('removes its HTTP routes on plugin unload while leaving the base authentication active', async () => {
  const fixture = await boot()
  const browser = fixture.browser()
  await begin(browser)
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '../../src/browser/index.ts')?.fiber
  if (fiber === undefined) throw new Error('Expected controller fiber')
  await fiber.dispose()
  expect((await browser.request('begin')).status).toBe(404)
  expect((await browser.request('begin', {}, false)).status).toBe(401)
})

it('cancels an admitted body reader and cannot mutate associations after plugin unload', async () => {
  const fixture = await boot()
  const browser = fixture.browser()
  const admitted = Promise.withResolvers<undefined>()
  let writer: ReadableStreamDefaultController<Uint8Array> | undefined
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { writer = controller },
    pull() { admitted.resolve(undefined) },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const response = fixture.ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
    fixture.origin + '/api/mcp-proxy/begin', {
      method: 'POST', headers: { Host: new URL(fixture.origin).host, Origin: fixture.origin,
        Cookie: [...browser.jar.values()].join('; '), 'Content-Type': 'application/json',
      }, body: stream, duplex: 'half',
    } as RequestInit & { duplex: 'half' },
  ))
  await admitted.promise
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '../../src/browser/index.ts')?.fiber
  if (fiber === undefined) throw new Error('Expected controller fiber')
  await fiber.dispose()
  if (!cancelled) {
    writer?.enqueue(Buffer.from('{}'))
    writer?.close()
  }
  expect((await response).status).not.toBe(200)
  expect(cancelled).toBe(true)
})

it('delegates an unchanged prompt envelope with one-use authority only for its exact Session and request', async () => {
  const fixture = await boot()
  const local = await fixture.ready()
  const browser = fixture.browser()
  const request = await begin(browser)
  local.socket.send(JSON.stringify({ v: 1, kind: 'association', requestId: request.requestId }))
  const pong = once(local.socket, 'message')
  local.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  await pong
  expect((await browser.request('finish', { requestId: request.requestId })).status).toBe(200)
  const envelope = { type: 'client-request', rpcId: 'wire-id', method: 'session/prompt',
    payload: { args: { request: { sessionId: 'session', requestId: 'request', content: ['original content'] } } },
  }
  fixture.ctx.effect(() => fixture.ctx.connection.rpc.intercept('/api', () => true, async (_endpoint, payload) => {
    expect(payload).toEqual(envelope.payload)
    const admissions = fixture.ctx.mcpProxy.admissions
    expect(admissions.claim(promptAdmissionId('wrong-session', 'request'))).toBeUndefined()
    expect(admissions.claim(promptAdmissionId('session', 'wrong-request'))).toBeUndefined()
    const selected = admissions.claim(promptAdmissionId('session', 'request'))
    expect(admissions.claim(promptAdmissionId('session', 'request'))).toBeUndefined()
    return { ok: true, value: { endpoint: selected ?? null } }
  }))
  const response = await browser.request('../session/prompt', envelope)
  expect(response.status).toBe(200)
  expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/)
  expect(await response.json()).toMatchObject({ result: { ok: true, value: { endpoint: local.identity.endpointId } } })
  expect(fixture.ctx.mcpProxy.admissions.claim(promptAdmissionId('session', 'request'))).toBeUndefined()
  const unbound = fixture.browser()
  const unboundResponse = await unbound.request('../session/prompt', envelope)
  expect(unboundResponse.headers.get('set-cookie')).toBeNull()
  expect(await unboundResponse.json()).toMatchObject({ result: { value: { endpoint: null } } })
  unbound.jar.set('unrelated', 'unrelated=one; unrelated=two')
  expect((await unbound.request('../session/prompt', envelope)).status).toBe(200)
  unbound.jar.set('unrelated', 'unrelated=' + 'x'.repeat(9000))
  expect((await unbound.request('../session/prompt', envelope)).status).toBe(200)
  expect(await (await browser.request('../session/queue', { ...envelope, method: 'session/queue' })).json()).toMatchObject({ result: { value: { endpoint: null } } })
  const grant = [...browser.jar].find(([name]) => name.includes('-grant-'))
  if (grant === undefined) throw new Error('Expected grant')
  browser.jar.set(grant[0], grant[1] + 'tampered')
  expect((await browser.request('../session/prompt', envelope)).status).toBe(409)
  expect((await browser.request('begin')).status).toBe(200)
})

it('aborts delegated prompt admission on unload after its HTTP body has already ended', async () => {
  const fixture = await boot()
  const local = await fixture.ready()
  const browser = fixture.browser()
  const transaction = await begin(browser)
  local.socket.send(JSON.stringify({ v: 1, kind: 'association', requestId: transaction.requestId }))
  const barrier = once(local.socket, 'message')
  local.socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  await barrier
  expect((await browser.request('finish', { requestId: transaction.requestId })).status).toBe(200)
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let aborted = false
  onTestFinished(() => { released.resolve(undefined) })
  fixture.ctx.effect(() => fixture.ctx.connection.rpc.intercept('/api', () => true, async (_endpoint, _payload, signal) => {
    signal.addEventListener('abort', () => { aborted = true; released.resolve(undefined) }, { once: true })
    entered.resolve(undefined)
    await released.promise
    return { ok: true, value: {} }
  }))
  const request = browser.request('../session/prompt', { type: 'client-request', rpcId: 'wire', method: 'session/prompt',
    payload: { args: { request: { sessionId: 'session', requestId: 'request', content: [] } } },
  }).then(value => ({ value }), (error: unknown) => ({ error }))
  await entered.promise
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '../../src/browser/index.ts')?.fiber
  if (fiber === undefined) throw new Error('Expected controller owner')
  const closing = fiber.dispose()
  await expect.poll(() => aborted, { timeout: 1000 }).toBe(true)
  await request
  await closing
  expect(fixture.ctx.mcpProxy.admissions.claim(promptAdmissionId('session', 'request'))).toBeUndefined()
})
