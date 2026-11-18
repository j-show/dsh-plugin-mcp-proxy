import { expect, it, vi, onTestFinished } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ElicitationController, type ElicitationId } from '../../src/client/elicitation-controller.ts'
import type { ProxyFetch } from '../../src/client/controller.ts'

const config = { pollIntervalMs: 500, statusIntervalMs: 15000,
  associationTimeoutMs: 30000, requestTimeoutMs: 10000, maxResponseBytes: 65536 }

const sessionId = 'session-a' as SessionId
const pending = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sessionId, expiresAt: 9999999999999,
  params: { mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
}

function observe(fetch: ProxyFetch) {
  const lifetime = new AbortController()
  const work: Promise<void>[] = []
  const controller = new ElicitationController(config, sessionId, fetch, lifetime.signal, (task) => { work.push(task) })
  const detach = controller.state.subscribe(() => {})
  onTestFinished(async () => { detach(); lifetime.abort(); await Promise.allSettled(work) })
  return { controller, lifetime }
}

it('preserves a reopened observer when transport cancellation synchronously remounts the page', async () => {
  const lifetime = new AbortController()
  const entered = Promise.withResolvers<undefined>()
  const work: Promise<void>[] = []
  let reads = 0
  let reopened: (() => void) | undefined
  let initial: (() => void) | undefined
  const controller = new ElicitationController(config, sessionId, async (_url, init) => {
    if (++reads !== 1) return Response.json({ pending })
    entered.resolve(undefined)
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reopened = controller.state.subscribe(() => {})
        reject(init.signal?.reason)
      }, { once: true })
    })
  }, lifetime.signal, (task) => { work.push(task) })
  onTestFinished(async () => { initial?.(); reopened?.(); lifetime.abort(); await Promise.allSettled(work) })
  initial = controller.state.subscribe(() => {})
  await entered.promise
  initial()
  initial = undefined
  await Promise.allSettled(work)
  expect(reads).toBe(2)
  expect(controller.state.getSnapshot().pending?.id).toBe(pending.id)
  await controller.refresh()
  expect(reads).toBe(3)
})

it('represents a Session with no pending request as an empty view without an error', async () => {
  const { controller } = observe(async () => Response.json({ pending: null }))
  await controller.refresh()
  expect(controller.state.getSnapshot()).toEqual({ pending: null, busy: false, error: false })
})

it.each([
  undefined,
  { ...pending, id: 1 },
  { ...pending, id: 'not-an-id' },
  { ...pending, expiresAt: 0.5 },
  { ...pending, params: { mode: 'form', message: 1 } },
  { ...pending, params: { mode: 'unknown', message: 'Question' } },
  { ...pending, params: { mode: 'url', message: 'Question' } },
])('does not present malformed or missing request metadata %#', async (value) => {
  const { controller } = observe(async () => Response.json({ pending: value }))
  await controller.refresh()
  expect(controller.state.getSnapshot()).toEqual({ pending: null, busy: false, error: true })
})

it('reports a refused pending-request read without inventing a question', async () => {
  const { controller } = observe(async () => Response.json({}, { status: 503 }))
  await controller.refresh()
  expect(controller.state.getSnapshot()).toEqual({ pending: null, busy: false, error: true })
})

it.each(['decline', 'cancel'] as const)('answers a URL request with %s and no form payload', async (action) => {
  const requests: unknown[] = []
  const { controller } = observe(async (url, init) => {
    if (url.endsWith('/respond')) { requests.push(JSON.parse(String(init.body))); return Response.json({ state: 'answered' }) }
    return Response.json({ pending: { ...pending, params: { mode: 'url', message: 'Continue', url: 'https://auth.example/continue' } } })
  })
  await controller.refresh()
  const question = controller.state.getSnapshot().pending
  if (question === null) throw new Error('Expected URL request')
  expect(question.params).toEqual({ mode: 'url', message: 'Continue', url: 'https://auth.example/continue' })
  await controller.respond(question.id, action)
  expect(requests).toEqual([{ sessionId, id: pending.id, response: { action } }])
  expect(controller.state.getSnapshot()).toEqual({ pending: null, busy: false, error: false })
})

it.each([{ status: 503, state: 'refused' }, { status: 200, state: 'not-answered' }])
('retains an unanswered form when an explicit response write fails %#', async ({ status, state }) => {
  const { controller } = observe(async url => url.endsWith('/respond') ? Response.json({ state }, { status })
    : Response.json({ pending }))
  await controller.refresh()
  const question = controller.state.getSnapshot().pending
  if (question === null) throw new Error('Expected form request')
  await controller.respond(question.id, 'accept', { name: 'Ada' })
  expect(controller.state.getSnapshot()).toMatchObject({ pending: { id: pending.id }, busy: false, error: true })
})

it('coalesces duplicate answer gestures and avoids metadata reads during the admitted write', async () => {
  const reply = Promise.withResolvers<Response>()
  let writes = 0
  let reads = 0
  const { controller } = observe(async (url) => {
    if (url.endsWith('/respond')) { writes++; return reply.promise }
    reads++
    return Response.json({ pending })
  })
  onTestFinished(() => { reply.resolve(Response.json({ state: 'answered' })) })
  await controller.refresh()
  const question = controller.state.getSnapshot().pending
  if (question === null) throw new Error('Expected form request')
  await controller.respond('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as ElicitationId, 'cancel')
  const answer = controller.respond(question.id, 'accept', { name: 'Ada' })
  expect(controller.respond(question.id, 'decline')).toBe(answer)
  await controller.refresh()
  expect(writes).toBe(1)
  expect(reads).toBe(1)
  reply.resolve(Response.json({ state: 'answered' }))
  await answer
  expect(controller.state.getSnapshot().pending).toBeNull()
})

it('polls while observed and stops page reads without sending tool cancellation', async () => {
  vi.useFakeTimers()
  const requests: string[] = []
  const { controller, lifetime } = observe(async (url) => { requests.push(url); return Response.json({ pending }) })
  onTestFinished(() => { vi.useRealTimers() })
  const second = controller.state.subscribe(() => {})
  await controller.refresh()
  second()
  await vi.advanceTimersByTimeAsync(config.pollIntervalMs)
  expect(requests).toHaveLength(2)
  lifetime.abort()
  await vi.advanceTimersByTimeAsync(config.pollIntervalMs * 2)
  await controller.respond(pending.id as ElicitationId, 'cancel')
  expect(requests).toEqual(['/api/mcp-proxy/elicitation/pending', '/api/mcp-proxy/elicitation/pending'])
})

it('does not request metadata for an already-disposed page', async () => {
  const lifetime = new AbortController()
  lifetime.abort()
  const fetch = vi.fn(async () => Response.json({ pending }))
  const controller = new ElicitationController(config, sessionId, fetch, lifetime.signal, () => {})
  await controller.refresh()
  const detach = controller.state.subscribe(() => {})
  await controller.respond(pending.id as ElicitationId, 'cancel')
  detach()
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['http://localhost/continue', 'https://auth.example/continue'])('presents the admitted HTTP navigation URL %s', async (url) => {
  const { controller } = observe(async () => Response.json({ pending: { ...pending, params: { mode: 'url', message: 'Continue', url } } }))
  await controller.refresh()
  expect(controller.state.getSnapshot().pending?.params).toEqual({ mode: 'url', message: 'Continue', url })
})

it('fetches the retained request on a fresh page and answers only that Session request', async () => {
  const requests: string[] = []
  const lifetime = new AbortController()
  const work = new Set<Promise<void>>()
  let value: unknown = pending
  const fetch = async (url: string, init: RequestInit) => {
    requests.push(url)
    if (url.endsWith('/respond')) {
      expect(JSON.parse(String(init.body))).toMatchObject({ sessionId, id: pending.id,
        response: { action: 'accept', content: { name: 'Ada' } },
      })
      value = null
      return Response.json({ state: 'answered' })
    }
    return Response.json({ pending: value })
  }
  const track = (task: Promise<void>) => { work.add(task); void task.finally(() => { work.delete(task) }) }
  const first = new ElicitationController(config, sessionId, fetch, lifetime.signal, track)
  const release = first.state.subscribe(() => {})
  await first.refresh()
  expect(first.state.getSnapshot().pending?.params.message).toBe('Your name?')
  release()
  const reopened = new ElicitationController(config, sessionId, fetch, lifetime.signal, track)
  const detach = reopened.state.subscribe(() => {})
  try {
    await reopened.refresh()
    const question = reopened.state.getSnapshot().pending
    if (question === null) throw new Error('Expected retained request')
    await reopened.respond(question.id, 'accept', { name: 'Ada' })
    expect(reopened.state.getSnapshot().pending).toBeNull()
    expect(requests.every(url => url.includes('/elicitation/'))).toBe(true)
  } finally { detach(); lifetime.abort(); await Promise.allSettled(work) }
})

it('refuses a response naming another Session and exposes a fixed UI error', async () => {
  const lifetime = new AbortController()
  const work: Promise<void>[] = []
  const controller = new ElicitationController(config, sessionId,
    async () => Response.json({ pending: { ...pending, sessionId: 'other' } }), lifetime.signal, (task) => { work.push(task) })
  const detach = controller.state.subscribe(() => {})
  try {
    await controller.refresh()
    expect(controller.state.getSnapshot()).toMatchObject({ pending: null, error: true })
  } finally { detach(); lifetime.abort(); await Promise.allSettled(work) }
})

it('does not restore an answered question from a delayed metadata response', async () => {
  const lifetime = new AbortController()
  const work: Promise<void>[] = []
  const older = Promise.withResolvers<Response>()
  let reads = 0
  let answered = false
  const controller = new ElicitationController(config, sessionId, async (url) => {
    if (url.endsWith('/respond')) { answered = true; return Response.json({ state: 'answered' }) }
    if (++reads === 2) return older.promise
    return Response.json({ pending: answered ? null : pending })
  }, lifetime.signal, (task) => { work.push(task) })
  const detach = controller.state.subscribe(() => {})
  try {
    await controller.refresh()
    const stale = controller.refresh()
    const question = controller.state.getSnapshot().pending
    if (question === null) throw new Error('Expected live question')
    await controller.respond(question.id, 'accept', { name: 'Ada' })
    older.resolve(Response.json({ pending }))
    await stale
    expect(controller.state.getSnapshot()).toMatchObject({ pending: null, error: false })
  } finally { older.resolve(Response.json({ pending: null })); detach(); lifetime.abort(); await Promise.allSettled(work) }
})

it.each(['javascript:alert(1)', 'data:text/plain,private', 'https://user:password@auth.example', 'https://:password@auth.example'])
('does not expose the unsupported navigation URL %s', async (url) => {
  const lifetime = new AbortController()
  const work: Promise<void>[] = []
  const controller = new ElicitationController(config, sessionId, async () => Response.json({ pending: {
    ...pending, params: { mode: 'url', message: 'Open a page', url },
  } }), lifetime.signal, (task) => { work.push(task) })
  const detach = controller.state.subscribe(() => {})
  try {
    await controller.refresh()
    expect(controller.state.getSnapshot()).toMatchObject({ pending: null, error: true })
  } finally { detach(); lifetime.abort(); await Promise.allSettled(work) }
})
