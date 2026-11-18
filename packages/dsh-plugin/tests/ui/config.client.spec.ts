import { expect, it, vi, onTestFinished } from 'vitest'
import { readUiConfig } from '../../src/client/config.ts'

it('uses Host deployment budgets rather than silently retaining Client defaults', async () => {
  const bootstrap = { pollIntervalMs: 500, statusIntervalMs: 15000,
    associationTimeoutMs: 30000, requestTimeoutMs: 10000, maxResponseBytes: 65536 }
  const configured = await readUiConfig(bootstrap,
    async () => Response.json({ ...bootstrap, maxResponseBytes: 1234 }), new AbortController().signal)
  expect(configured.maxResponseBytes).toBe(1234)
})

it.each([0, 'not-a-budget'])('rejects invalid Host configuration values %#', async (maxResponseBytes) => {
  const bootstrap = { pollIntervalMs: 500, statusIntervalMs: 15000,
    associationTimeoutMs: 30000, requestTimeoutMs: 10000, maxResponseBytes: 65536 }
  await expect(readUiConfig(bootstrap, async () => Response.json({ ...bootstrap, maxResponseBytes }), new AbortController().signal))
    .rejects.toThrow('MCP proxy UI configuration unavailable')
})

it('cancels the response body when the configuration endpoint refuses the request', async () => {
  const bootstrap = { pollIntervalMs: 500, statusIntervalMs: 15000,
    associationTimeoutMs: 30000, requestTimeoutMs: 10000, maxResponseBytes: 65536 }
  let cancelled = false
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { status: 401 })
  await expect(readUiConfig(bootstrap, async () => response, new AbortController().signal)).rejects.toThrow('configuration unavailable')
  expect(cancelled).toBe(true)
})

it('rejects missing or extra configuration fields rather than retaining partial deployment budgets', async () => {
  const bootstrap = { pollIntervalMs: 500, statusIntervalMs: 15000,
    associationTimeoutMs: 30000, requestTimeoutMs: 10000, maxResponseBytes: 65536 }
  for (const value of [{ ...bootstrap, extra: true }, { pollIntervalMs: 500 }]) {
    await expect(readUiConfig(bootstrap, async () => Response.json(value), new AbortController().signal))
      .rejects.toThrow('configuration unavailable')
  }
})

it('applies the bootstrap request deadline before Host budgets are available', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const bootstrap = { pollIntervalMs: 500, statusIntervalMs: 15000,
    associationTimeoutMs: 30000, requestTimeoutMs: 5, maxResponseBytes: 65536 }
  let requestSignal: AbortSignal | undefined
  const pending = readUiConfig(bootstrap, async (_url, init) => {
    requestSignal = init.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(init.signal?.reason) }, { once: true })
    })
  }, new AbortController().signal)
  const result = expect(pending).rejects.toThrow('configuration unavailable')
  await vi.advanceTimersByTimeAsync(5)
  await result
  expect(requestSignal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
