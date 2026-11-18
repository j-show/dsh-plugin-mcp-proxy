/** Browser association state; cookies remain HttpOnly and server-owned. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ProxyUiConfig } from '../ui/types.ts'
import { objectValue } from './response.ts'
import { proxyPost } from './post.ts'
import { parseProxyActivation } from '@jshow/app-mcp-proxy/protocol/activation'

/** Presentation states independent of Session and device identifiers. */
export type ConnectionPhase = 'loading' | 'unbound' | 'opening' | 'waiting' | 'connected' | 'disconnecting' | 'unavailable'
/** Registrant-private observable data shown by the connection settings page. */
export interface ConnectionState { readonly phase: ConnectionPhase; readonly services: readonly string[]; readonly uri: string | null }
/** Existing same-origin browser HTTP capability. */
export type ProxyFetch = (url: string, init: RequestInit) => Promise<Response>

/** Own page-lifetime metadata and one browser association action at a time. */
export class ProxyConnectionController {
  /** Observable connection state for the settings presentation. */
  readonly state = createSnapshotStore<ConnectionState>({ phase: 'unbound', services: [], uri: null })
  private readonly lifetime = new AbortController()
  private readonly tasks = new Set<Promise<void>>()
  private operation: { readonly kind: 'connect' | 'disconnect'; readonly promise: Promise<void> } | undefined
  private reading: Promise<void> | undefined
  private attempt: AbortController | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private generation = 0
  /** @param config - validated UI budgets. @param fetch - same-origin carrier. @param activate - local protocol launch request. */
  constructor(
    private readonly config: ProxyUiConfig, private readonly fetch: ProxyFetch, private readonly activate: (uri: string) => void,
  ) {}
  /** Begin page-lifetime status observation. */
  start(): void {
    if (this.interval !== undefined || this.lifetime.signal.aborted) return
    this.state.set({ phase: 'loading', services: [], uri: null })
    void this.refresh()
    this.interval = setInterval(() => { void this.refresh() }, this.config.statusIntervalMs)
  }
  /**
   * Begin a browser transaction and activate the local protocol handler.
   * @returns settlement of a coalesced connect action.
   */
  connect(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    if (this.operation?.kind === 'connect') return this.operation.promise
    if (this.operation !== undefined) return this.operation.promise.then(() => this.connect())
    const generation = ++this.generation
    return this.action('connect', () => this.associate(generation))
  }
  /**
   * Refresh browser association state from the server.
   * @returns settlement of an explicit status read.
   */
  refresh(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    if (this.operation !== undefined) return this.operation.promise
    if (this.reading !== undefined) return this.reading
    const generation = this.generation
    const task = Promise.resolve().then(async () => {
      try { await this.readStatus(this.lifetime.signal, generation) } catch (_error) {
        this.publish(generation, { phase: 'unavailable', services: [], uri: null })
      }
    })
    this.reading = task
    this.track(task, () => { this.reading = undefined })
    return task
  }
  /**
   * Clear this browser association without changing another browser.
   * @returns settlement of browser grant revocation; never stops the local daemon.
   */
  disconnect(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    if (this.operation?.kind === 'disconnect') return this.operation.promise
    const previous = this.operation?.promise
    const generation = ++this.generation
    this.attempt?.abort()
    return this.action('disconnect', async () => {
      this.publish(generation, { phase: 'disconnecting', services: [], uri: null })
      await previous
      try {
        const reply = await this.post('revoke', {}, this.lifetime.signal)
        if (reply.status !== 200 || reply.value['state'] !== 'unbound') throw new Error('Association revocation failed')
        this.publish(generation, { phase: 'unbound', services: [], uri: null })
      } catch (_error) { this.publish(generation, { phase: 'unavailable', services: [], uri: null }) }
    })
  }
  /** Cancel and await all owned browser work. */
  async close(): Promise<void> {
    this.lifetime.abort()
    this.attempt?.abort()
    clearInterval(this.interval)
    await Promise.allSettled(this.tasks)
  }

  private action(kind: 'connect' | 'disconnect', work: () => Promise<void>): Promise<void> {
    const task = Promise.resolve().then(work)
    const operation = { kind, promise: task }
    this.operation = operation
    this.track(task, () => { if (this.operation === operation) this.operation = undefined })
    return task
  }

  private track(task: Promise<void>, settled: () => void): void {
    this.tasks.add(task)
    const finish = (): void => { this.tasks.delete(task); settled() }
    void task.then(finish, finish)
  }

  private publish(generation: number, state: ConnectionState): void {
    if (!this.lifetime.signal.aborted && generation === this.generation) this.state.set(state)
  }

  private async associate(generation: number): Promise<void> {
    if (this.lifetime.signal.aborted || generation !== this.generation) return
    const attempt = new AbortController()
    this.attempt = attempt
    const signal = AbortSignal.any([this.lifetime.signal, attempt.signal])
    const timer = setTimeout(() => { attempt.abort() }, this.config.associationTimeoutMs)
    try {
      this.publish(generation, { phase: 'opening', services: [], uri: null })
      const reply = await this.post('begin', {}, signal)
      const id = reply.value['requestId']
      const uri = reply.value['uri']
      if (reply.status !== 200 || typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)
        || typeof uri !== 'string' || parseProxyActivation(uri).requestId !== id) throw new Error('Invalid association transaction')
      this.publish(generation, { phase: 'waiting', services: [], uri })
      signal.throwIfAborted()
      try { this.activate(uri) } catch (_error) {
        // Browser activation can be refused; the UI retains a user-clickable URI while confirmation is pending.
      }
      while (true) {
        signal.throwIfAborted()
        const finished = await this.post('finish', { requestId: id }, signal)
        if (finished.status === 200 && finished.value['state'] === 'bound') {
          await this.readStatus(signal, generation)
          return
        }
        if (finished.status !== 409) throw new Error('Association completion failed')
        signal.throwIfAborted()
        await this.delay(signal)
      }
    } catch (_error) { this.publish(generation, { phase: 'unavailable', services: [], uri: null }) }
    finally {
      clearTimeout(timer)
      this.attempt = undefined
    }
  }

  private async readStatus(signal: AbortSignal, generation: number): Promise<void> {
    const reply = await this.post('status', {}, signal)
    if (reply.status !== 200) throw new Error('Association status unavailable')
    const phase = reply.value['state']
    if (phase === 'unbound' || phase === 'unavailable') { this.publish(generation, { phase, services: [], uri: null }); return }
    if (phase !== 'connected' || !Array.isArray(reply.value['services'])) throw new Error('Invalid association status')
    const services = reply.value['services'].map((value: unknown) => {
      const service = objectValue(value)['service']
      if (typeof service !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(service)) throw new Error('Invalid service alias')
      return service
    })
    this.publish(generation, { phase: 'connected', services, uri: null })
  }

  private async post(route: string, body: Record<string, unknown>, signal: AbortSignal) {
    return proxyPost(this.config, this.fetch, route, body, signal)
  }

  private delay(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Association cancelled')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, this.config.pollIntervalMs)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
}
