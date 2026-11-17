/** Preserve cancellation of every valid legacy callback ID, including numeric zero. */
import { CancelledNotificationSchema, type RequestId } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { InvocationId } from '@jshow/app-mcp-proxy/protocol'
import { z } from 'zod'
import type { LegacyTaskScope } from './legacy-task-scope.ts'

interface CallbackRecord {
  readonly id: RequestId
  readonly method: 'sampling' | 'elicitation'
  readonly controller: AbortController
  readonly response: Promise<unknown>
}

/** SDK 1.29.0 skips cancellation ID zero; observe the public transport without patching SDK internals. */
export class LegacyCancellation {
  private readonly callbacks = new Map<string, CallbackRecord>()
  private closed = false

  /** @param capacity - resolved generation-wide record bound. @param maxBytes - complete JSON-RPC response bound. */
  constructor(private readonly capacity: number, private readonly maxBytes: number) {}

  /**
   * Add cancellation ownership to an SDK callback.
   * @param id - original SDK request identity, including zero.
   * @param signal - SDK request cancellation.
   * @param work - handler using the combined cancellation signal.
   * @param method - protocol callback kind; reuse with another kind is invalid.
   * @param parent - exact active proxy invocation; completed responses never cross parent scopes.
   * @returns detached retained response; duplicates never execute the handler again.
   */
  run(
    id: RequestId, signal: AbortSignal, work: (signal: AbortSignal) => Promise<unknown>,
    method: CallbackRecord['method'], parent: InvocationId,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Local MCP callback generation is closed'))
    const key = JSON.stringify([parent, id])
    const previous = this.callbacks.get(key)
    if (previous !== undefined) {
      if (previous.method !== method) return Promise.reject(new Error('Conflicting local MCP callback identity'))
      return previous.response.then(value => structuredClone(value))
    }
    if (this.callbacks.size >= this.capacity) return Promise.reject(new Error('Local MCP callback capacity exhausted'))
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    const response = Promise.resolve().then(async () => {
      combined.throwIfAborted()
      const value = structuredClone(await work(combined))
      combined.throwIfAborted()
      if (!z.json().safeParse(value).success) throw new Error('Invalid local MCP callback response')
      const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, result: value }), 'utf8')
      if (bytes > this.maxBytes) throw new Error('Local MCP callback response exceeds limit')
      return value
    })
    this.callbacks.set(key, { id, method, controller, response })
    return response.then(value => structuredClone(value))
  }

  /**
   * Wrap a newly owned transport before connecting the legacy SDK client.
   * @param base - transport whose callbacks are not owned by another client.
   * @param task - optional synchronous task ownership observer for the same client.
   * @returns a transparent SDK transport with zero-safe callback cancellation.
   */
  wrap(base: Transport, task?: LegacyTaskScope): Transport {
    const setProtocolVersion = base.setProtocolVersion?.bind(base)
    const wrapper: Transport = {
      start: async () => {
        base.onmessage = (message, extra) => {
          task?.received(message)
          if ('method' in message && message.method === 'notifications/cancelled') {
            const parsed = CancelledNotificationSchema.safeParse(message)
            if (parsed.success && parsed.data.params.requestId !== undefined) {
              for (const record of this.callbacks.values()) if (record.id === parsed.data.params.requestId) record.controller.abort()
            }
          }
          wrapper.onmessage?.(message, extra)
        }
        base.onclose = () => { this.abort(); wrapper.onclose?.() }
        base.onerror = error => wrapper.onerror?.(error)
        await base.start()
      },
      send: (message, options) => { task?.sent(message); return base.send(message, options) },
      close: async () => { this.abort(); await base.close() },
      ...(setProtocolVersion === undefined ? {} : { setProtocolVersion }),
    }
    Object.defineProperty(wrapper, 'sessionId', { get: () => base.sessionId })
    return wrapper
  }

  private abort(): void {
    this.closed = true
    for (const record of this.callbacks.values()) record.controller.abort()
    this.callbacks.clear()
  }
}
