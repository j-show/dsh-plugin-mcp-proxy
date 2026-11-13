/** Nested MCP requests scoped to one live invocation and authenticated connection generation. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { decodeFrame, type CallbackId, type GenerationId, type ProxyFrame } from './protocol.ts'
import type { InvocationId } from './invocations.ts'

/** Tool-initiated model or human request with exact parent identity. */
export type ProxyCallbackRequest = Readonly<Extract<ProxyFrame, { kind: 'callback' }>>
/** An invocation owner answers nested requests and settles when its supplied signal aborts. */
export type ProxyCallbackHandler = (request: ProxyCallbackRequest, signal: AbortSignal) => Promise<Record<string, unknown>>
type CallbackResult = Extract<ProxyFrame, { kind: 'callback-result' }>['response']
interface Parent { readonly signal: AbortSignal; readonly handler: ProxyCallbackHandler | undefined }
interface Pending {
  readonly parent: InvocationId
  readonly resolve: (value: CallbackResult) => void
  readonly reject: (error: Error) => void
  readonly dispose: () => void
}
interface RecordEntry {
  readonly request: ProxyCallbackRequest
  readonly controller: AbortController
  readonly response: Promise<ProxyFrame>
  reply?: ProxyFrame
}
/** Private channel-owned callback exchange; no independent connection or invocation lifetime. */
export class CallbackExchange {
  private readonly pending = new Map<CallbackId, Pending>()
  private readonly records = new Map<CallbackId, RecordEntry>()
  private readonly work = new Set<Promise<void>>()
  private readonly stop = new AbortController()

  /**
   * @param policy - authenticated generation and bounded capacities.
   * @param send - existing channel frame sender.
   * @param parent - outgoing invocation owner, absent after its settlement.
   * @param executing - incoming invocation signal, absent outside execution.
   */
  constructor(
    private readonly policy: { generation: GenerationId; maxFrameBytes: number; maxPending: number; maxInvocations: number },
    private readonly send: (frame: ProxyFrame) => void,
    private readonly parent: (id: InvocationId) => Parent | undefined,
    private readonly executing: (id: InvocationId) => AbortSignal | undefined,
  ) {}

  /**
   * Send a bounded callback owned by its parent invocation.
   * @param parent - currently executing incoming tool invocation.
   * @param method - supported downstream request kind.
   * @param params - JSON request parameters.
   * @param timeoutMs - bounded nested request deadline.
   * @param signal - SDK request cancellation.
   * @returns the validated JSON response from that invocation's remote owner.
   */
  request(parent: InvocationId, method: 'sampling' | 'elicitation', params: Record<string, unknown>, timeoutMs: number,
    signal: AbortSignal): Promise<CallbackResult> {
    const owner = this.executing(parent)
    if (owner === undefined || this.stop.signal.aborted || this.pending.size >= this.policy.maxPending) {
      return Promise.reject(new Error('MCP callback parent or capacity unavailable'))
    }
    const combined = AbortSignal.any([signal, owner, this.stop.signal])
    if (combined.aborted) return Promise.reject(new Error('MCP callback cancelled'))
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
      return Promise.reject(new Error('Invalid MCP callback deadline'))
    }
    const id = randomUUID() as CallbackId
    const frame = decodeFrame(JSON.stringify({ v: 1, kind: 'callback', id, parent, generation: this.policy.generation, method, params }),
      this.policy.maxFrameBytes)
    const deferred = Promise.withResolvers<CallbackResult>()
    const interrupt = (): void => {
      if (!this.pending.delete(id)) return
      dispose()
      deferred.reject(new Error('MCP callback interrupted'))
      this.send({ v: 1, kind: 'callback-cancel', id, parent, generation: this.policy.generation })
    }
    const timer = setTimeout(interrupt, timeoutMs)
    timer.unref()
    const dispose = (): void => { clearTimeout(timer); combined.removeEventListener('abort', interrupt) }
    this.pending.set(id, { parent, resolve: deferred.resolve, reject: deferred.reject, dispose })
    combined.addEventListener('abort', interrupt, { once: true })
    if (combined.aborted) interrupt()
    if (this.pending.has(id)) this.send(frame)
    return deferred.promise
  }

  /**
   * Handle parent-correlated callback requests, replies and cancellation.
   * @param frame - already validated generation frame.
   * @returns whether this exchange consumed the message.
   */
  receive(frame: ProxyFrame): boolean {
    if (frame.kind === 'callback-result' || frame.kind === 'callback-failure') {
      const pending = this.pending.get(frame.id)
      if (pending?.parent !== frame.parent) return true
      this.pending.delete(frame.id)
      pending.dispose()
      if (frame.kind === 'callback-result') pending.resolve(frame.response)
      else pending.reject(new Error(`MCP callback ${frame.code}`))
    } else if (frame.kind === 'callback-cancel') {
      const record = this.records.get(frame.id)
      if (record?.request.parent === frame.parent) record.controller.abort()
    } else if (frame.kind === 'callback') {
      const task = this.answer(frame)
      this.work.add(task)
      void task.then(() => { this.work.delete(task) })
    } else return false
    return true
  }

  /** Abort pending requests synchronously when the enclosing channel stops. */
  stopped(): void {
    this.stop.abort()
    for (const pending of this.pending.values()) {
      pending.dispose()
      pending.reject(new Error('MCP callback connection lost'))
    }
    this.pending.clear()
  }

  /**
   * Wait for owned callback operations to settle.
   * @returns after every admitted response owner has settled.
   */
  async drain(): Promise<void> { await Promise.all(this.work) }

  private async answer(request: ProxyCallbackRequest): Promise<void> {
    const failure = (code: 'failed' | 'cancelled' | 'unsupported' | 'unknown'): ProxyFrame => ({
      v: 1, kind: 'callback-failure', id: request.id, parent: request.parent, generation: this.policy.generation, code,
    })
    const parent = this.parent(request.parent)
    if (parent === undefined || parent.signal.aborted || this.stop.signal.aborted) { this.send(failure('unknown')); return }
    const existing = this.records.get(request.id)
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing.request, request)) this.send(failure('failed'))
      else if (existing.reply !== undefined) this.send(existing.reply)
      return
    }
    if (this.records.size >= this.policy.maxInvocations) {
      this.send(failure('failed')); return
    }
    const controller = new AbortController()
    if (this.work.size >= this.policy.maxPending) {
      const reply = failure('failed')
      this.records.set(request.id, { request, controller, reply, response: Promise.resolve(reply) })
      this.send(reply)
      return
    }
    const signal = AbortSignal.any([parent.signal, controller.signal, this.stop.signal])
    const response = Promise.resolve().then(async (): Promise<ProxyFrame> => {
      if (parent.handler === undefined) return failure('unsupported')
      try {
        signal.throwIfAborted()
        const result = await parent.handler(structuredClone(request), signal)
        signal.throwIfAborted()
        return decodeFrame(JSON.stringify({ v: 1, kind: 'callback-result', id: request.id, parent: request.parent,
          generation: this.policy.generation, response: result }), this.policy.maxFrameBytes)
      } catch (_error) {
        // Handler exceptions and returned invalid data may contain secrets.
        return failure(signal.aborted ? 'cancelled' : 'failed')
      }
    })
    const record: RecordEntry = { request, controller, response }
    this.records.set(request.id, record)
    record.reply = await response
    this.send(record.reply)
  }
}
