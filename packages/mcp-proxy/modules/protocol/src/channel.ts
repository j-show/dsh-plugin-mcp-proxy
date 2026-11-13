/** Invocation exchange on an owner-authenticated WebSocket. */
import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { decodeFrame, type GenerationId, type ProxyFrame } from './protocol.ts'
import { InvocationLedger, type InvocationId } from './invocations.ts'
import { CallbackExchange, type ProxyCallbackHandler } from './callback-channel.ts'
type Invoke = Extract<ProxyFrame, { kind: 'invoke' }>
type Result = Extract<ProxyFrame, { kind: 'result' }>['result']
/** Resolved limits and execution owner for a single authenticated socket generation. */
export interface ChannelOptions {
  readonly generation: GenerationId
  readonly maxFrameBytes: number
  readonly maxInvocations: number
  readonly maxPending: number
  /** Application heartbeat policy; omitted only when another owner supervises liveness. */
  readonly heartbeat?: { readonly intervalMs: number; readonly timeoutMs: number }
  /** Execute exactly once; the handler must settle when its signal aborts. */
  readonly onInvoke?: (frame: Invoke, signal: AbortSignal) => Promise<Result>
}

/** Connection failure with explicit side-effect uncertainty. */
export class ProxyCallError extends Error {
  /** @param code - protocol outcome. @param message - non-secret diagnostic. */
  constructor(readonly code: 'unavailable' | 'failed' | 'unknown' | 'cancelled', message: string) {
    super(message)
    this.name = 'ProxyCallError'
  }
}

interface PendingCall {
  readonly resolve: (value: Result) => void
  readonly reject: (error: Error) => void
  readonly dispose: () => void
  readonly signal: AbortSignal
  readonly handler: ProxyCallbackHandler | undefined
}

/** Invoke request fields before the wire parser brands and validates identities. */
export interface ProxyInvocationRequest {
  readonly revision: string
  readonly service: string
  readonly name: string
  readonly args: Record<string, unknown>
}

/** Request/result exchange; its owner must authenticate the socket before construction. */
export class ProxyChannel {
  private readonly pending = new Map<InvocationId, PendingCall>()
  private readonly controllers = new Map<InvocationId, AbortController>()
  private readonly results = new Map<InvocationId, ProxyFrame>()
  private readonly work = new Set<Promise<void>>()
  private readonly ledger: InvocationLedger
  private readonly options: ChannelOptions
  private closed = false
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatDeadline: ReturnType<typeof setTimeout> | undefined
  private readonly callbacks: CallbackExchange

  /** @param socket - open, owner-authenticated WebSocket. @param options - explicit deployment limits. */
  constructor(private readonly socket: WebSocket, options: ChannelOptions) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('MCP proxy socket is not open')
    for (const value of [options.maxFrameBytes, options.maxInvocations, options.maxPending]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('MCP proxy limits must be positive safe integers')
    }
    this.options = { ...options }
    if (options.heartbeat !== undefined) {
      for (const value of [options.heartbeat.intervalMs, options.heartbeat.timeoutMs]) {
        if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new RangeError('Invalid MCP proxy heartbeat policy')
      }
    }
    this.ledger = new InvocationLedger(options.maxInvocations)
    this.callbacks = new CallbackExchange(options, frame => this.send(frame), id => this.pending.get(id),
      id => this.controllers.get(id)?.signal)
    socket.on('message', this.receive)
    socket.on('close', this.stopped)
    socket.on('error', this.stopped)
    this.armHeartbeat()
  }

  /**
   * Forward one operation; no timeout, disconnect or late result resends it.
   * @param request - selected catalog revision, service, tool and arguments.
   * @param timeoutMs - positive timer-safe operation deadline.
   * @param signal - caller cancellation; cancellation after dispatch has an unknown side-effect outcome.
   * @param handler - this invocation's optional model/human callback owner.
   * @returns the complete validated MCP result, or a rejection with explicit uncertainty.
   */
  invoke(request: ProxyInvocationRequest, timeoutMs: number, signal?: AbortSignal, handler?: ProxyCallbackHandler): Promise<Result> {
    if (signal?.aborted) return Promise.reject(new ProxyCallError('cancelled', 'MCP proxy invocation cancelled before dispatch'))
    if (this.closed) return Promise.reject(new ProxyCallError('unavailable', 'MCP proxy connection is closed'))
    if (this.pending.size >= this.options.maxPending) return Promise.reject(new ProxyCallError('unavailable', 'MCP proxy pending capacity exhausted'))
    const id = randomUUID() as InvocationId
    const frame = decodeFrame(JSON.stringify({ v: 1, kind: 'invoke', id, generation: this.options.generation, ...request, timeoutMs }), this.options.maxFrameBytes)
    const deferred = Promise.withResolvers<Result>()
    const callbackStop = new AbortController()
    let dispatched = false
    const interrupt = (): void => {
      if (!this.pending.has(id)) return
      this.pending.delete(id)
      dispose()
      deferred.reject(new ProxyCallError(dispatched ? 'unknown' : 'cancelled', 'MCP proxy invocation interrupted; outcome unknown after dispatch'))
      if (dispatched) this.send({ v: 1, kind: 'cancel', id, generation: this.options.generation })
    }
    const timer = setTimeout(interrupt, timeoutMs)
    timer.unref()
    const dispose = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', interrupt); callbackStop.abort() }
    this.pending.set(id, { resolve: deferred.resolve, reject: deferred.reject, dispose, signal: callbackStop.signal, handler })
    signal?.addEventListener('abort', interrupt, { once: true })
    if (signal?.aborted) interrupt()
    if (this.pending.has(id)) { dispatched = true; this.send(frame) }
    return deferred.promise
  }

  /**
   * Forward a callback while preserving its parent invocation.
   * @param parent - exact currently executing local invocation.
   * @param method - supported tool-initiated request kind.
   * @param params - JSON request parameters.
   * @param timeoutMs - bounded response deadline.
   * @param signal - nested request lifetime.
   * @returns validated JSON supplied by the originating remote invocation owner.
   */
  callback(parent: InvocationId, method: 'sampling' | 'elicitation', params: Record<string, unknown>, timeoutMs: number,
    signal: AbortSignal): Promise<Extract<ProxyFrame, { kind: 'callback-result' }>['response']> {
    return this.callbacks.request(parent, method, params, timeoutMs, signal)
  }

  /** Stop both directions and await socket closure plus cooperative local handlers. */
  async close(): Promise<void> {
    this.stopped()
    if (this.socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((resolve) => { this.socket.once('close', resolve) })
      this.socket.terminate()
      await closed
    }
    await Promise.all(this.work)
    await this.callbacks.drain()
    this.socket.off('message', this.receive)
    this.socket.off('close', this.stopped)
    this.socket.off('error', this.stopped)
  }

  private readonly stopped = (): void => {
    if (this.closed) return
    this.closed = true
    this.callbacks.stopped()
    clearTimeout(this.heartbeatTimer)
    clearTimeout(this.heartbeatDeadline)
    this.ledger.disconnect()
    for (const pending of this.pending.values()) {
      pending.dispose()
      pending.reject(new ProxyCallError('unknown', 'MCP proxy connection lost; outcome unknown'))
    }
    this.pending.clear()
    for (const controller of this.controllers.values()) controller.abort()
  }

  private readonly receive = (data: RawData, binary: boolean): void => {
    if (this.closed) return
    let frame: ProxyFrame
    try {
      if (binary) throw new Error('MCP proxy expects text frames')
      frame = decodeFrame(data.toString(), this.options.maxFrameBytes)
      if ('generation' in frame && frame.generation !== this.options.generation) throw new Error('MCP proxy generation mismatch')
    } catch (_error) {
      // Invalid peer data cannot continue on an authenticated execution channel.
      this.stopped()
      this.socket.terminate()
      return
    }
    if (this.callbacks.receive(frame)) return
    if (frame.kind === 'ping') this.send({ v: 1, kind: 'pong' })
    else if (frame.kind === 'pong') {
      if (this.heartbeatDeadline !== undefined) {
        clearTimeout(this.heartbeatDeadline)
        this.heartbeatDeadline = undefined
        this.armHeartbeat()
      }
    } else if (frame.kind === 'result' || frame.kind === 'failure') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      pending.dispose()
      if (frame.kind === 'result') pending.resolve(frame.result)
      else pending.reject(new ProxyCallError(frame.code, frame.message || `MCP proxy invocation ${frame.code}`))
    } else if (frame.kind === 'cancel') {
      this.controllers.get(frame.id)?.abort()
    } else if (frame.kind === 'invoke') {
      const task = this.execute(frame)
      this.work.add(task)
      void task.then(() => { this.work.delete(task) })
    }
  }

  private armHeartbeat(): void {
    const policy = this.options.heartbeat
    if (policy === undefined || this.closed) return
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatDeadline = setTimeout(() => { this.stopped(); this.socket.terminate() }, policy.timeoutMs)
      this.heartbeatDeadline.unref()
      this.send({ v: 1, kind: 'ping' })
    }, policy.intervalMs)
    this.heartbeatTimer.unref()
  }

  private async execute(frame: Invoke): Promise<void> {
    const failure = (code: 'unavailable' | 'failed' | 'unknown', message: string): ProxyFrame => ({ v: 1, kind: 'failure', id: frame.id, generation: this.options.generation, code, message })
    let admission
    try {
      admission = this.ledger.begin(frame.id)
    } catch (_error) {
      // Refusing a fresh identity must not execute or evict a previous identity.
      this.send(failure('unavailable', 'MCP proxy invocation capacity exhausted'))
      return
    }
    if (!admission.execute) {
      const result = this.results.get(frame.id)
      if (result !== undefined) this.send(result)
      return
    }
    if (this.controllers.size >= this.options.maxPending) {
      const reply = failure('unavailable', 'MCP proxy local execution capacity exhausted')
      this.ledger.settle(frame.id, 'failed')
      this.results.set(frame.id, reply)
      this.send(reply)
      return
    }
    const controller = new AbortController()
    this.controllers.set(frame.id, controller)
    const timer = setTimeout(() => { controller.abort() }, frame.timeoutMs)
    timer.unref()
    let reply: ProxyFrame
    try {
      if (this.options.onInvoke === undefined) reply = failure('unavailable', 'MCP proxy has no local executor')
      else {
        const result = await this.options.onInvoke(frame, controller.signal)
        reply = decodeFrame(JSON.stringify({ v: 1, kind: 'result', id: frame.id, generation: this.options.generation, result }), this.options.maxFrameBytes)
      }
    } catch (_error) {
      // Caller-owned exceptions may contain secrets; only protocol diagnostics cross the wire.
      reply = failure(controller.signal.aborted ? 'unknown' : 'failed', 'Local MCP invocation did not complete successfully')
    } finally {
      clearTimeout(timer)
      this.controllers.delete(frame.id)
    }
    if (controller.signal.aborted) reply = failure('unknown', 'Local MCP invocation was interrupted; outcome unknown')
    const outcome = reply.kind === 'result' ? 'succeeded' : reply.kind === 'failure' && reply.code === 'unknown' ? 'unknown' : 'failed'
    if (this.ledger.settle(frame.id, outcome)) {
      this.results.set(frame.id, reply)
      this.send(reply)
    }
  }

  private send(frame: ProxyFrame): void {
    if (this.closed) return
    let payload = JSON.stringify(frame)
    if (Buffer.byteLength(payload, 'utf8') > this.options.maxFrameBytes && frame.kind === 'failure') {
      // Retain the machine-readable outcome when the diagnostic cannot fit.
      payload = JSON.stringify({ ...frame, message: '' })
    }
    if (Buffer.byteLength(payload, 'utf8') > this.options.maxFrameBytes) {
      this.stopped()
      this.socket.terminate()
      return
    }
    this.socket.send(payload, (error) => {
      if (error) { this.stopped(); this.socket.terminate() }
    })
  }
}
