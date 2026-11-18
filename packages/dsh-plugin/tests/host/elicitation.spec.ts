import { expect, it, vi } from 'vitest'
import { ElicitationStore } from '../../src/host/elicitation.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

const first = SessionId('session-a')
const second = SessionId('session-b')

const form = { message: 'Your name?', mode: 'form', requestedSchema: {
  type: 'object', properties: { name: { type: 'string' } }, required: ['name'],
} }
const config = { maxPending: 2, lifetimeMs: 10000, maxRequestBytes: 4096 }

it.each([0, -1, 1.5, Infinity, 2147483648])('rejects invalid continuation budgets %s', (value) => {
  expect(() => new ElicitationStore({ ...config, maxPending: value })).toThrow('Invalid elicitation limits')
})

it.each(['file:///tmp/private', 'https://user:secret@example.com/confirm', 'ftp://example.com/confirm'])(
  'rejects unsafe URL elicitation %s without retaining a continuation', async (url) => {
    const store = new ElicitationStore(config)
    try {
      await expect(store.ask(first, { mode: 'url', message: 'Confirm', url, elicitationId: 'external-id' },
        new AbortController().signal, () => {})).rejects.toThrow('Unsupported elicitation URL')
      expect(store.pending(first)).toBeUndefined()
    } finally { store.close() }
  })

it('accepts a URL acknowledgement without exposing form values', async () => {
  const store = new ElicitationStore(config)
  const outcome = store.ask(first, { mode: 'url', message: 'Confirm', url: 'https://example.com/confirm', elicitationId: 'external-id' },
    new AbortController().signal, () => {}).then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    const pending = store.pending(first)
    if (pending === undefined) throw new Error('Expected pending URL')
    expect(pending.params).toMatchObject({ mode: 'url', elicitationId: 'external-id' })
    await expect(store.answer(first, pending.id, { action: 'accept', content: { secret: 'private' } }))
      .rejects.toThrow('URL elicitation has no form content')
    expect(store.pending(first)?.id).toBe(pending.id)
    await store.answer(first, pending.id, { action: 'accept' })
    expect(await outcome).toEqual({ value: { action: 'accept' } })
  } finally { store.close() }
})

it.each(['decline', 'cancel'])('keeps a form pending after invalid %s content, then settles without content', async (action) => {
  const store = new ElicitationStore(config)
  const outcome = store.ask(first, form, new AbortController().signal, () => {})
    .then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    const pending = store.pending(first)
    if (pending === undefined) throw new Error('Expected pending form')
    await expect(store.answer(first, pending.id, { action, content: { name: 'Ada' } })).rejects.toThrow('Declined elicitation has no content')
    await expect(store.answer(first, pending.id, { action: 'unknown' })).rejects.toThrow('Invalid elicitation response')
    await store.answer(first, pending.id, { action })
    expect(await outcome).toEqual({ value: { action } })
  } finally { store.close() }
})

it('refuses a form answer cancelled while its asynchronous schema validation settles', async () => {
  const store = new ElicitationStore(config)
  const stop = new AbortController()
  const outcome = store.ask(first, form, stop.signal, () => {})
    .then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    const pending = store.pending(first)
    if (pending === undefined) throw new Error('Expected pending form')
    const answering = store.answer(first, pending.id, { action: 'accept', content: { name: 'Ada' } })
    stop.abort()
    await expect(answering).rejects.toThrow('Elicitation no longer pending')
    expect(await outcome).toMatchObject({ error: { code: 'cancelled' } })
    expect(store.pending(first)).toBeUndefined()
  } finally { store.close() }
})

it.each(['pending', 'answer'])('expires a wait through %s before its timer runs', async (action) => {
  const store = new ElicitationStore(config)
  const outcome = store.ask(first, form, new AbortController().signal, () => {})
    .then(value => ({ value }), (error: unknown) => ({ error }))
  const pending = store.pending(first)
  if (pending === undefined) throw new Error('Expected pending form')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(pending.expiresAt)
  try {
    if (action === 'answer') await expect(store.answer(first, pending.id, { action: 'cancel' })).rejects.toThrow('Elicitation expired')
    expect(store.pending(first)).toBeUndefined()
    expect(await outcome).toMatchObject({ error: { code: 'expired' } })
  } finally { clock.mockRestore(); store.close() }
})

it('refuses an answer whose deadline expires during asynchronous form validation', async () => {
  const store = new ElicitationStore(config)
  const outcome = store.ask(first, form, new AbortController().signal, () => {})
    .then(value => ({ value }), (error: unknown) => ({ error }))
  const pending = store.pending(first)
  if (pending === undefined) throw new Error('Expected pending form')
  const answering = store.answer(first, pending.id, { action: 'accept', content: { name: 'Ada' } })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(pending.expiresAt)
  try {
    await expect(answering).rejects.toThrow('Elicitation no longer pending')
    expect(store.pending(first)).toBeUndefined()
    expect(await outcome).toMatchObject({ error: { code: 'expired' } })
  } finally { clock.mockRestore(); store.close() }
})

it('refuses malformed, oversized, pre-cancelled and closed requests before publishing a human wait', async () => {
  const store = new ElicitationStore({ ...config, maxRequestBytes: 256 })
  const publish = vi.fn()
  try {
    await expect(store.ask(first, { mode: 'form' }, new AbortController().signal, publish)).rejects.toThrow('Invalid elicitation request')
    await expect(store.ask(first, { ...form, message: 'x'.repeat(257) }, new AbortController().signal, publish))
      .rejects.toThrow('Elicitation request too large')
    await expect(store.ask(first, form, AbortSignal.abort(), publish)).rejects.toThrow()
    store.close()
    await expect(store.ask(first, form, new AbortController().signal, publish)).rejects.toThrow('Elicitation capacity unavailable')
    expect(publish).not.toHaveBeenCalled()
  } finally { store.close() }
})

it('retains a human request without a page and accepts only a schema-valid answer from its Session', async () => {
  const store = new ElicitationStore(config)
  const stop = new AbortController()
  try {
    const answer = store.ask(first, form, stop.signal, () => {}).then(value => ({ value }), (error: unknown) => ({ error }))
    const pending = store.pending(first)
    if (pending === undefined) throw new Error('Expected pending form')
    expect(store.pending(second)).toBeUndefined()
    await expect(store.answer(second, pending.id, { action: 'accept', content: { name: 'Ada' } })).rejects.toThrow()
    await expect(store.answer(first, pending.id, { action: 'accept', content: { name: 42 } })).rejects.toThrow()
    expect(store.pending(first)?.id).toBe(pending.id)
    await store.answer(first, pending.id, { action: 'accept', content: { name: 'Ada' } })
    expect(await answer).toMatchObject({ value: { action: 'accept', content: { name: 'Ada' } } })
    expect(store.pending(first)).toBeUndefined()
    await expect(store.answer(first, pending.id, { action: 'accept', content: { name: 'Again' } })).rejects.toThrow()
  } finally { stop.abort(); store.close() }
})

it('releases a pending human wait when the original invocation aborts', async () => {
  const store = new ElicitationStore(config)
  const stop = new AbortController()
  const answer = store.ask(first, form, stop.signal, () => {})
  const outcome = answer.then(value => ({ value }), (error: unknown) => ({ error }))
  stop.abort()
  expect(await outcome).toMatchObject({ error: expect.any(Error) })
  expect(store.pending(first)).toBeUndefined()
  store.close()
})

it('cancels a wait when its durable publisher synchronously cancels the invocation', async () => {
  const store = new ElicitationStore(config)
  const stop = new AbortController()
  try {
    await expect(store.ask(first, form, stop.signal, () => { stop.abort() })).rejects.toMatchObject({ code: 'cancelled' })
    expect(store.pending(first)).toBeUndefined()
  } finally { store.close() }
})

it('retains cancellation settlement when the publisher aborts then throws', async () => {
  const store = new ElicitationStore(config)
  const stop = new AbortController()
  try {
    await expect(store.ask(first, form, stop.signal, () => {
      stop.abort()
      stop.signal.throwIfAborted()
    })).rejects.toMatchObject({ code: 'cancelled' })
    expect(store.pending(first)).toBeUndefined()
  } finally { store.close() }
})

it('keeps an accepted request when another request exceeds its configured pending capacity', async () => {
  const store = new ElicitationStore({ ...config, maxPending: 1 })
  const answer = store.ask(first, form, new AbortController().signal, () => {})
  const outcome = answer.then(value => ({ value }), (error: unknown) => ({ error }))
  await expect(store.ask(second, form, new AbortController().signal, () => {})).rejects.toThrow()
  expect(store.pending(first)).toBeDefined()
  store.close()
  expect(await outcome).toMatchObject({ error: expect.any(Error) })
})

it('expires a human wait and removes its live browser projection', async () => {
  const store = new ElicitationStore({ ...config, lifetimeMs: 1000 })
  try {
    await expect(store.ask(first, form, new AbortController().signal, () => {})).rejects.toMatchObject({ code: 'expired' })
    expect(store.pending(first)).toBeUndefined()
  } finally { store.close() }
})

it('settles one answer when two schema-valid replies race', async () => {
  const store = new ElicitationStore(config)
  const waiting = store.ask(first, form, new AbortController().signal, () => {})
  const outcome = waiting.then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    const pending = store.pending(first)
    if (pending === undefined) throw new Error('Expected pending form')
    const answers = await Promise.allSettled(['Ada', 'Grace'].map(name =>
      store.answer(first, pending.id, { action: 'accept', content: { name } })))
    expect(answers.filter(answer => answer.status === 'fulfilled')).toHaveLength(1)
    expect(await outcome).toMatchObject({ value: { action: 'accept' } })
  } finally { store.close() }
})

it('does not retain a request when its durable publication fails', async () => {
  const store = new ElicitationStore(config)
  try {
    await expect(store.ask(first, form, new AbortController().signal, () => {
      throw new Error('fixture-private-publication')
    })).rejects.toThrow('Elicitation did not complete')
    expect(store.pending(first)).toBeUndefined()
  } finally { store.close() }
})
