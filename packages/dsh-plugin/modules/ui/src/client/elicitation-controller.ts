/** Session-scoped observation of server-owned human waits; page teardown never answers or cancels them. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ProxyUiConfig } from '../types.ts'
import type { ProxyFetch } from './controller.ts'
import { objectValue } from './response.ts'
import { proxyPost } from './post.ts'
import { elicitationFields, type ElicitationField } from './elicitation-fields.ts'

/** Opaque response identity carried only by the server-owned request. */
export type ElicitationId = Branded<'McpProxyElicitationId'>
/** Bounded current request, validated before presentation. */
export interface UiElicitation {
  readonly id: ElicitationId
  readonly params: { readonly mode: 'form'; readonly message: string; readonly fields: readonly ElicitationField[] }
    | { readonly mode: 'url'; readonly message: string; readonly url: string }
}
/** Private observable presentation facts for one mounted Session. */
export interface ElicitationState { readonly pending: UiElicitation | null; readonly busy: boolean; readonly error: boolean }

/** Observe only while a framework hook subscribes and keep mutations explicit. */
export class ElicitationController {
  private readonly snapshot = createSnapshotStore<ElicitationState>({ pending: null, busy: false, error: false })
  private observers = 0
  private page: AbortController | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private generation = 0
  private reading: { generation: number; promise: Promise<void>; stop: AbortController } | undefined
  private answering: Promise<void> | undefined
  /** Bare source; the slot renderer creates its subscription hook. */
  readonly state: ObservableSnapshot<ElicitationState> = {
    getSnapshot: () => this.snapshot.getSnapshot(),
    subscribe: (listener) => {
      const remove = this.snapshot.subscribe(listener)
      if (++this.observers === 1 && !this.lifetime.aborted) {
        this.page = new AbortController()
        this.lifetime.addEventListener('abort', this.stop, { once: true })
        void this.refresh()
        this.interval = setInterval(() => { void this.refresh() }, this.config.pollIntervalMs)
      }
      return () => { remove(); if (--this.observers === 0) this.stop() }
    },
  }
  /**
   * @param config - validated UI budgets.
   * @param sessionId - mounted Session owner.
   * @param fetch - same-origin browser carrier.
   * @param lifetime - plugin lifetime; abort clears active timers and requests.
   * @param retainWork - plugin disposal barrier for active and unsubscribed requests.
   */
  constructor(private readonly config: ProxyUiConfig, private readonly sessionId: SessionId,
    private readonly fetch: ProxyFetch, private readonly lifetime: AbortSignal,
    private readonly retainWork: (task: Promise<void>) => void) {}

  /**
   * Refresh pending human requests for this Session.
   * @returns one coalesced safe read; never creates or cancels a human wait.
   */
  refresh(): Promise<void> {
    const page = this.page
    if (page === undefined || this.answering !== undefined) return Promise.resolve()
    const generation = this.generation
    if (this.reading?.generation === generation) return this.reading.promise
    const stop = new AbortController()
    const task = Promise.resolve().then(async () => {
      try {
        const response = await proxyPost(this.config, this.fetch, 'elicitation/pending', { sessionId: this.sessionId },
          AbortSignal.any([page.signal, stop.signal]))
        if (response.status !== 200) throw new Error('Elicitation unavailable')
        const pending = this.parse(response.value['pending'])
        this.publish(generation, { pending, busy: false, error: false })
      } catch (_error) {
        if (!stop.signal.aborted) this.publish(generation, { ...this.snapshot.getSnapshot(), error: true })
      }
    }).finally(() => { if (this.reading?.promise === task) this.reading = undefined })
    this.reading = { generation, promise: task, stop }
    this.retainWork(task)
    return task
  }

  /**
   * Submit an answer to the selected pending human request.
   * @param id - exact currently presented request.
   * @param action - explicit human decision.
   * @param content - form values, absent for URL/decline/cancel.
   * @returns completion of one coalesced response write; failed writes are not replayed.
   */
  respond(id: ElicitationId, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): Promise<void> {
    if (this.answering !== undefined) return this.answering
    const page = this.page
    if (page === undefined || this.snapshot.getSnapshot().pending?.id !== id) {
      return Promise.resolve()
    }
    const generation = ++this.generation
    this.reading?.stop.abort()
    this.snapshot.set({ ...this.snapshot.getSnapshot(), busy: true, error: false })
    const task = Promise.resolve().then(async () => {
      try {
        const reply = await proxyPost(this.config, this.fetch, 'elicitation/respond', { sessionId: this.sessionId, id,
          response: { action, ...(content === undefined ? {} : { content }) },
        }, page.signal)
        if (reply.status !== 200 || reply.value['state'] !== 'answered') throw new Error('Elicitation response unavailable')
        this.publish(generation, { pending: null, busy: false, error: false })
      } catch (_error) { this.publish(generation, { ...this.snapshot.getSnapshot(), busy: false, error: true }) }
    }).finally(() => { this.answering = undefined })
    this.answering = task
    this.retainWork(task)
    return task
  }

  private readonly stop = (): void => {
    ++this.generation
    const page = this.page
    this.page = undefined
    clearInterval(this.interval)
    this.interval = undefined
    this.lifetime.removeEventListener('abort', this.stop)
    page?.abort()
  }
  private publish(generation: number, value: ElicitationState): void {
    if (generation === this.generation) this.snapshot.set(value)
  }
  private parse(value: unknown): UiElicitation | null {
    if (value === null) return null
    const record = objectValue(value)
    if (record['sessionId'] !== this.sessionId || typeof record['id'] !== 'string' || !/^[a-f0-9-]{36}$/.test(record['id'])
      || !Number.isSafeInteger(record['expiresAt'])) throw new Error('Invalid elicitation owner')
    const params = objectValue(record['params'])
    if (typeof params['message'] !== 'string') throw new Error('Invalid elicitation message')
    const id = record['id'] as ElicitationId
    if (params['mode'] === 'form') return { id, params: { mode: 'form', message: params['message'],
      fields: elicitationFields(objectValue(params['requestedSchema'])),
    } }
    if (params['mode'] !== 'url' || typeof params['url'] !== 'string') throw new Error('Invalid elicitation mode')
    const url = new URL(params['url'])
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) throw new Error('Invalid elicitation URL')
    return { id, params: { mode: 'url', message: params['message'], url: params['url'] } }
  }
}
