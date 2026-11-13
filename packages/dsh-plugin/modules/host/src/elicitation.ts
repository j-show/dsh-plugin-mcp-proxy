/** Invocation-owned human requests independent of any browser connection. */
import { randomUUID } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { fromJsonSchema, specTypeSchemas } from '@modelcontextprotocol/client'

/** One invocation-owned human continuation; never grants device or Session authority. */
export type ElicitationId = Branded<'McpProxyElicitationId'>
/** Validated storage budgets for pending human requests. */
export interface ElicitationOptions { readonly maxPending: number; readonly lifetimeMs: number; readonly maxRequestBytes: number }
/** Form values or URL-flow metadata available to the authenticated browser. */
export type ElicitationParams =
  | { readonly mode: 'form'; readonly message: string; readonly requestedSchema: Record<string, unknown> }
  | { readonly mode: 'url'; readonly message: string; readonly url: string; readonly elicitationId: string }
/** Live request metadata; URL authentication material must not be copied into Session events. */
export interface PendingElicitation {
  readonly id: ElicitationId
  readonly sessionId: SessionId
  readonly expiresAt: number
  readonly params: ElicitationParams
}
interface Entry {
  readonly pending: PendingElicitation
  readonly validate: ((value: unknown) => Promise<boolean>) | undefined
  readonly resolve: (value: Record<string, unknown>) => void
  readonly stop: (reason?: 'cancelled' | 'expired') => void
}
class WaitError extends Error {
  constructor(readonly code: 'cancelled' | 'expired') { super(`Elicitation ${code}`) }
}
/** Host-owned pending human continuations. */
export class ElicitationStore {
  private readonly entries = new Map<ElicitationId, Entry>()
  private closed = false
  /** @param options - explicit resource and lifetime limits. */
  constructor(private readonly options: ElicitationOptions) {
    for (const value of Object.values(options)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Invalid elicitation limits')
    }
  }
  /**
   * Own a human wait for one invocation until answer, cancellation or expiry.
   * @param sessionId - owning Session.
   * @param params - raw MCP request.
   * @param signal - parent lifetime.
   * @param publish - durable pending event; publication failure rejects admission unless cancellation settled first.
   * @returns a human response, independently of any page connection.
   */
  async ask(sessionId: SessionId, params: Record<string, unknown>, signal: AbortSignal,
    publish: (pending: PendingElicitation) => void): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    if (this.closed || this.entries.size >= this.options.maxPending) throw new Error('Elicitation capacity unavailable')
    if (Buffer.byteLength(JSON.stringify(params)) > this.options.maxRequestBytes) throw new Error('Elicitation request too large')
    const parsed = specTypeSchemas.ElicitRequestParams['~standard'].validate(params)
    if (parsed.issues !== undefined) throw new Error('Invalid elicitation request')
    const admitted = parsed.value
    let validate: Entry['validate']
    let metadata: ElicitationParams
    if ('requestedSchema' in admitted) {
      // Parsed form schemas are wire JSON; SDK optional members additionally admit undefined in their declarations.
      const schema = fromJsonSchema(admitted.requestedSchema as Parameters<typeof fromJsonSchema>[0])
      validate = async value => (await schema['~standard'].validate(value)).issues === undefined
      metadata = { mode: 'form', message: admitted.message, requestedSchema: admitted.requestedSchema }
    } else {
      const url = new URL(admitted.url)
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
        throw new Error('Unsupported elicitation URL')
      }
      metadata = { mode: 'url', message: admitted.message, url: admitted.url, elicitationId: admitted.elicitationId }
    }
    const pending: PendingElicitation = { id: randomUUID() as ElicitationId, sessionId,
      expiresAt: Date.now() + this.options.lifetimeMs, params: metadata,
    }
    const deferred = Promise.withResolvers<Record<string, unknown>>()
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.entries.delete(pending.id)
    }
    const stop = (reason: 'cancelled' | 'expired' = 'cancelled'): void => { cleanup(); deferred.reject(new WaitError(reason)) }
    const abort = (): void => { stop() }
    const timer = setTimeout(() => { stop('expired') }, this.options.lifetimeMs)
    timer.unref()
    this.entries.set(pending.id, { pending, validate, resolve: deferred.resolve, stop })
    signal.addEventListener('abort', abort, { once: true })
    try {
      try { publish(structuredClone(pending)) } catch (error) { deferred.reject(error) }
      return await deferred.promise
    } catch (error) {
      // Schema, callback and parser errors never expose request data in diagnostics.
      if (error instanceof WaitError) throw error
      throw new Error('Elicitation did not complete')
    } finally { cleanup() }
  }
  /**
   * Read the pending human request owned by the selected Session.
   * @param sessionId - owning Session.
   * @returns its next live request.
   */
  pending(sessionId: SessionId): PendingElicitation | undefined {
    for (const entry of this.entries.values()) {
      if (entry.pending.expiresAt <= Date.now()) { entry.stop('expired'); continue }
      if (entry.pending.sessionId === sessionId) return structuredClone(entry.pending)
    }
    return undefined
  }
  /**
   * Validate and settle the selected human request once.
   * @param sessionId - owning Session.
   * @param id - pending identity.
   * @param response - human answer.
   * @returns after one schema-valid answer consumes the wait; invalid answers leave it pending.
   */
  async answer(sessionId: SessionId, id: ElicitationId, response: Record<string, unknown>): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined || entry.pending.sessionId !== sessionId) throw new Error('Elicitation unavailable')
    if (entry.pending.expiresAt <= Date.now()) { entry.stop('expired'); throw new Error('Elicitation expired') }
    const parsed = specTypeSchemas.ElicitResult['~standard'].validate(response)
    if (parsed.issues !== undefined) throw new Error('Invalid elicitation response')
    const value = parsed.value
    if (value.action === 'accept') {
      if (entry.validate !== undefined && !await entry.validate(value.content)) throw new Error('Invalid elicitation form response')
      if (entry.validate === undefined && value.content !== undefined) throw new Error('URL elicitation has no form content')
    } else if (value.content !== undefined) throw new Error('Declined elicitation has no content')
    const result = { action: value.action, ...(value.content === undefined ? {} : { content: value.content }) }
    if (this.entries.get(id) !== entry || entry.pending.expiresAt <= Date.now()) throw new Error('Elicitation no longer pending')
    this.entries.delete(id)
    entry.resolve(result)
  }
  /** Cancel all pending continuations. */
  close(): void {
    this.closed = true
    for (const entry of this.entries.values()) entry.stop()
  }
}
