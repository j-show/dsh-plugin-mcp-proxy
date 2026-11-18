/** Browser association routes for authenticated Connection requests. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ElicitationId } from '../host/index.ts'
import type { AssociationHandle, AssociationRequestId, BrowserBindingId } from '@jshow/app-mcp-proxy/protocol'
import { proxyActivationUri } from '@jshow/app-mcp-proxy/protocol'
import { observePrompt } from './prompt.ts'
import { bridge } from './http-bridge.ts'

/** Stable Cordis plugin name. */
export const name = 'api-mcp-proxy-controller'
/** Existing HTTP authentication and local endpoint owner. */
export const inject = ['connection', 'mcpProxy']

/** Explicit admission limits for small browser association requests. */
export interface Config {
  /** Maximum parsed browser request body size in bytes. */
  readonly maxRequestBytes: number
  /** Maximum incoming cookie header size in bytes. */
  readonly maxCookieBytes: number
  /** Maximum incoming cookie entries to inspect. */
  readonly maxCookieEntries: number
  /** Browser binding lifetime in milliseconds. */
  readonly browserLifetimeMs: number
  /** Maximum observed prompt envelope size in bytes. */
  readonly maxPromptBytes: number
  /** Maximum concurrently observed prompt requests. */
  readonly maxPromptRequests: number
}
/** Validated deployment configuration. */
export const Config: z<Config> = z.object({
  maxRequestBytes: z.natural().min(1).default(4096),
  maxCookieBytes: z.natural().min(1).default(8192),
  maxCookieEntries: z.natural().min(1).default(64),
  browserLifetimeMs: z.natural().min(1).max(2147483647).default(86400000),
  maxPromptBytes: z.natural().min(1).default(314572800),
  maxPromptRequests: z.natural().min(1).default(32),
})

class RequestError extends Error {
  constructor(readonly status: number) { super('MCP proxy association unavailable') }
}

function json(value: unknown, status = 200, cookie?: string): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...(cookie === undefined ? {} : { 'set-cookie': cookie }) } })
}

async function body(request: Request, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader()
  if (reader === undefined) throw new RequestError(400)
  let cancellation: Promise<void> | undefined
  const abort = (): void => {
    cancellation ??= reader.cancel().catch((_error: unknown) => {
      // A carrier may already have destroyed the stream; it owns its transport cleanup.
    })
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new RequestError(413)
      chunks.push(chunk.value)
    }
    if (signal.aborted) throw new RequestError(503)
  } finally {
    signal.removeEventListener('abort', abort)
    await cancellation
    reader.releaseLock()
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (_error) {
    // Parser diagnostics can contain browser secrets; return a fixed admission failure.
    throw new RequestError(400)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400)
  return value as Record<string, unknown>
}

/**
 * Mount browser association routes behind the existing Connection authentication.
 * @param ctx - authenticated host context.
 * @param config - deployment request and cookie limits.
 */
export function apply(ctx: Context, config: Config): void {
  const spec = Config(config)
  const origin = ctx.mcpProxy.publicOrigin
  const suffix = createHash('sha256').update(origin).digest('hex').slice(0, 16)
  const browserCookie = `__Host-mcp-proxy-browser-${suffix}`
  const grantCookie = `__Host-mcp-proxy-grant-${suffix}`
  const key = randomBytes(32)
  const stop = new AbortController()
  const stopped = (): boolean => stop.signal.aborted
  const active = new Set<Promise<Response>>()
  const prompts = new Set<Promise<void>>()
  ctx.effect(() => async () => {
    stop.abort()
    await Promise.all(active)
    await Promise.allSettled(prompts)
  })
  const sign = (value: string): string => createHmac('sha256', key).update(JSON.stringify([origin, value])).digest('base64url')
  const cookie = (name: string, value: string, expiresAt: number): string =>
    `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`

  function cookies(request: Request): Map<string, string> {
    const header = request.headers.get('cookie') ?? ''
    if (Buffer.byteLength(header) > spec.maxCookieBytes) throw new RequestError(400)
    const entries = header.split(';').filter(entry => entry.trim() !== '')
    if (entries.length > spec.maxCookieEntries) throw new RequestError(400)
    const result = new Map<string, string>()
    for (const entry of entries) {
      const index = entry.indexOf('=')
      if (index < 1) throw new RequestError(400)
      const name = entry.slice(0, index).trim()
      if (name.length === 0 || result.has(name)) throw new RequestError(400)
      result.set(name, entry.slice(index + 1).trim())
    }
    return result
  }

  function browser(request: Request, entries: Map<string, string>, create: boolean) {
    let value = entries.get(browserCookie)
    const parts = value?.split('.')
    const payload = parts?.slice(0, 2).join('.')
    const signature = parts?.[2]
    const valid = parts?.length === 3 && /^[A-Za-z0-9_-]{43}$/.test(parts[0] ?? '')
      && /^\d{1,16}$/.test(parts[1] ?? '') && Number(parts[1]) > Date.now()
      && Number.isSafeInteger(Number(parts[1])) && signature !== undefined && /^[A-Za-z0-9_-]{43}$/.test(signature)
      && payload !== undefined && timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))
    let issued: string | undefined
    if (!valid) {
      if (!create) throw new RequestError(409)
      const expiresAt = Date.now() + spec.browserLifetimeMs
      const payload = `${randomBytes(32).toString('base64url')}.${expiresAt}`
      value = `${payload}.${sign(payload)}`
      issued = cookie(browserCookie, value, expiresAt)
    }
    // Ask the public authentication owner which cookie authenticates this request; cookie names stay owner-private.
    const authenticated = [...entries].filter(([name, value]) => {
      if (name === browserCookie || name === grantCookie) return false
      const headers = new Headers(request.headers)
      headers.set('cookie', `${name}=${value}`)
      return ctx.connection.requestRejection({ headers }) === undefined
    }).map(([name, value]) => `${name}=${value}`).sort()
    if (authenticated.length === 0) throw new RequestError(401)
    const id = createHash('sha256').update(JSON.stringify([origin, value, authenticated])).digest('base64url') as BrowserBindingId
    return { id, issued }
  }

  ctx.on('connection/request', async (request, response, next) => {
    if (request.method !== 'POST' || new URL(request.url ?? '/', origin).pathname !== '/api/session/prompt') return next()
    const rawCookie = request.headers.cookie
    if (rawCookie === undefined || !rawCookie.split(';').some(entry => entry.split('=', 1)[0]?.trim() === grantCookie)) return next()
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value)
    const carrier = new Request(origin + '/api/session/prompt', { headers })
    let endpoint
    try {
      const entries = cookies(carrier)
      if (stop.signal.aborted || prompts.size >= spec.maxPromptRequests) throw new RequestError(503)
      const binding = browser(carrier, entries, false)
      endpoint = ctx.mcpProxy.associations.resolve(entries.get(grantCookie) as AssociationHandle, binding.id)
      if (ctx.mcpProxy.select(endpoint) === undefined) throw new RequestError(409)
      const grant = ctx.mcpProxy.associations.renew(entries.get(grantCookie) as AssociationHandle, binding.id)
      response.appendHeader('set-cookie', cookie(grantCookie, grant.handle, grant.expiresAt))
    } catch (error) {
      response.writeHead(error instanceof RequestError ? error.status : 409, { 'cache-control': 'no-store', connection: 'close' })
      response.end('MCP proxy association unavailable')
      return
    }
    const observation = observePrompt(request, spec.maxPromptBytes)
    const abort = (): void => { request.destroy(); response.destroy() }
    stop.signal.addEventListener('abort', abort, { once: true })
    const operation = ctx.mcpProxy.admissions.run(endpoint, observation.identity, next)
    prompts.add(operation)
    try { await operation } finally {
      observation.dispose()
      stop.signal.removeEventListener('abort', abort)
      prompts.delete(operation)
    }
  })

  const carrier = ctx.connection.createSharedFetchHandler('/api')
  ctx.on('connection/request', async (request, response, next) => {
    const pathname = new URL(request.url ?? '/', origin).pathname
    if (!pathname.startsWith('/api/mcp-proxy/') && pathname !== '/api/session/prompt') return next()
    await bridge(request, response, carrier, spec.maxPromptBytes)
  })

  for (const route of ['begin', 'finish', 'status', 'revoke', 'elicitation/pending', 'elicitation/respond']) {
    ctx.effect(() => ctx.connection.fetch.register({ path: `/api/mcp-proxy/${route}`, methods: ['POST'], requestBody: 'streaming',
      fetch: async (request) => {
        const operation = (async (): Promise<Response> => {
          try {
            if (stopped()) throw new RequestError(503)
            const input = await body(request, spec.maxRequestBytes, AbortSignal.any([request.signal, stop.signal]))
            if (stopped()) throw new RequestError(503)
            if (route === 'elicitation/pending' || route === 'elicitation/respond') {
              if (typeof input['sessionId'] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input['sessionId'])) {
                throw new RequestError(400)
              }
              const store = ctx.mcpProxy.elicitations
              const sessionId = input['sessionId'] as Parameters<typeof store.pending>[0]
              if (route === 'elicitation/pending') {
                if (Object.keys(input).length !== 1) throw new RequestError(400)
                return json({ pending: store.pending(sessionId) ?? null })
              }
              const response = input['response']
              if (Object.keys(input).length !== 3 || typeof input['id'] !== 'string'
                || !/^[a-f0-9-]{36}$/.test(input['id']) || response === null || typeof response !== 'object' || Array.isArray(response)) {
                throw new RequestError(400)
              }
              await store.answer(sessionId, input['id'] as ElicitationId, response as Record<string, unknown>)
              return json({ state: 'answered' })
            }
            if (route === 'finish') {
              if (Object.keys(input).length !== 1 || typeof input['requestId'] !== 'string'
              || !/^[A-Za-z0-9_-]{43}$/.test(input['requestId'])) throw new RequestError(400)
            } else if (Object.keys(input).length !== 0) throw new RequestError(400)
            return await ctx.mcpProxy.associationTransaction(() => {
              if (stopped() || request.signal.aborted) throw new RequestError(503)
              const entries = cookies(request)
              if (route === 'status' && !entries.has(grantCookie)) return json({ state: 'unbound' })
              if (route === 'revoke' && !entries.has(grantCookie) && !entries.has(browserCookie)) {
                return json({ state: 'unbound' }, 200, cookie(grantCookie, '', 0))
              }
              const binding = browser(request, entries, route === 'begin')
              const store = ctx.mcpProxy.associations
              if (route === 'begin') {
                const association = ctx.mcpProxy.beginAssociation(binding.id)
                const uri = ctx.mcpProxy.pairingEnabled ? proxyActivationUri(ctx.mcpProxy.publicOrigin, association.requestId)
                  : `mcp-proxy://associate/${association.requestId}`
                return json({ ...association, uri }, 200, binding.issued)
              }
              if (route === 'finish') {
                const grant = store.finish(input['requestId'] as AssociationRequestId, binding.id)
                return json({ state: 'bound', expiresAt: grant.expiresAt }, 200, cookie(grantCookie, grant.handle, grant.expiresAt))
              }
              if (route === 'revoke') {
                store.revoke(binding.id)
                return json({ state: 'unbound' }, 200, cookie(grantCookie, '', 0))
              }
              const endpoint = store.resolve((entries.get(grantCookie) ?? '') as AssociationHandle, binding.id)
              const selected = ctx.mcpProxy.select(endpoint)
              if (selected === undefined) return json({ state: 'unavailable', endpointId: endpoint })
              const grant = store.renew(entries.get(grantCookie) as AssociationHandle, binding.id)
              return json({
                state: 'connected', endpointId: endpoint, generation: selected.generation, revision: selected.catalog.revision,
                services: selected.catalog.services.map(entry => ({ service: entry.service })),
              }, 200, cookie(grantCookie, grant.handle, grant.expiresAt))
            })
          } catch (error) {
            // Store, authentication and parser details never enter HTTP diagnostics.
            return json({ error: 'mcp-proxy-association-unavailable' }, error instanceof RequestError ? error.status : 409)
          }
        })()
        active.add(operation)
        try { return await operation } finally { active.delete(operation) }
      },
    }))
  }
}
