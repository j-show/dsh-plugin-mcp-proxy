/** Browser wire parsing keeps bytes, cancellation and diagnostic ownership explicit. */
import { expect, it, vi, onTestFinished } from 'vitest'
import { responseObject } from '../../src/client/response.ts'
import { proxyPost } from '../../src/client/post.ts'

it('preserves Unicode split across transport chunks and enforces its UTF-8 byte budget', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ text: 'aé中' }))
  const response = (): Response => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }))
  const signal = new AbortController().signal
  const accepted = response()
  expect(await responseObject(accepted, bytes.length, signal)).toEqual({ text: 'aé中' })
  expect(accepted.body?.locked).toBe(false)
  const refused = response()
  await expect(responseObject(refused, bytes.length - 1, signal)).rejects.toThrow('exceeds budget')
  expect(refused.body?.locked).toBe(false)
})

it.each(['null', '[]', '"private body"', '{not-json'])('refuses non-object or malformed JSON without repeating %s', async (body) => {
  await expect(responseObject(new Response(body), 1024, new AbortController().signal))
    .rejects.toThrow('Invalid association response')
})

it('refuses a response with no readable body', async () => {
  await expect(responseObject(new Response(null), 1024, new AbortController().signal)).rejects.toThrow('Missing association response')
})

it('releases an already-cancelled reader even when its transport cancellation rejects', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() {
    cancelled = true
    throw new Error('Private transport failure')
  } }))
  const stop = new AbortController()
  stop.abort()
  await expect(responseObject(response, 1024, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancelled).toBe(true)
  expect(response.body?.locked).toBe(false)
})

it('aborts a stalled feature request at the configured deadline and clears its timer', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  let requestSignal: AbortSignal | undefined
  const pending = proxyPost({ pollIntervalMs: 100, statusIntervalMs: 100, associationTimeoutMs: 100,
    requestTimeoutMs: 5, maxResponseBytes: 1024,
  }, async (_url, init) => {
    requestSignal = init.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
    })
  }, 'status', {}, new AbortController().signal)
  const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(5)
  await result
  expect(requestSignal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
