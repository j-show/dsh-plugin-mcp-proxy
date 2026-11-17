/** Invocation ownership for downstream client callbacks and local roots. */
import { pathToFileURL } from 'node:url'
import type { InvocationId } from '@jshow/app-mcp-proxy/protocol'
import type { LocalServiceConfig } from './config.ts'

/** Tool-initiated request forwarded to the Harness model or human interaction owner. */
export interface LocalClientRequest {
  readonly service: string
  readonly invocationId: InvocationId
  readonly method: 'sampling' | 'elicitation'
  readonly params: Record<string, unknown>
  readonly signal: AbortSignal
}

/** Respond to one parent-correlated request; implementations must settle on cancellation. */
export type LocalClientRequestHandler = (request: LocalClientRequest) => Promise<unknown>

interface ActiveInvocation {
  readonly id: InvocationId | undefined
  readonly signal: AbortSignal
  requests: number
  readonly pending: Set<Promise<unknown>>
}

/** One serialized service call owns its callbacks until SDK work and teardown settle. */
export class CallbackOwner {
  private active: ActiveInvocation | undefined

  /**
   * @param config - immutable local service configuration.
   * @param limit - per-call request bound.
   * @param handler - optional remote request owner.
   */
  constructor(
    private readonly config: LocalServiceConfig, private readonly limit: number,
    private readonly handler: LocalClientRequestHandler | undefined,
  ) {}

  /**
   * Read explicitly configured roots before or during a Session.
   * @returns the local root URIs.
   */
  roots(): { roots: Array<{ uri: string }> } {
    return { roots: this.config.roots.map(path => ({ uri: pathToFileURL(path).href })) }
  }

  /**
   * Resolve a callback to its owning invocation.
   * @returns the exact live parent identity; throws outside a correlated invocation.
   */
  parentId(): InvocationId {
    const active = this.active
    if (active?.id === undefined) throw new Error('Local MCP callback has no originating invocation')
    active.signal.throwIfAborted()
    return active.id
  }

  /**
   * Execute under the service's unique callback owner.
   * @param id - originating proxy invocation, absent for direct unbound calls.
   * @param signal - exact operation cancellation.
   * @param work - SDK operation using the supplied owned signal, with no overlapping owner.
   * @returns the SDK result with callback ownership cleared after settlement.
   */
  async run(id: InvocationId | undefined, signal: AbortSignal, work: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    if (this.active !== undefined) throw new Error('Local MCP callback owner already active')
    const stop = new AbortController()
    const active = { id, signal: AbortSignal.any([signal, stop.signal]), requests: 0, pending: new Set<Promise<unknown>>() }
    this.active = active
    try {
      return await work(active.signal)
    } finally {
      stop.abort()
      await Promise.allSettled([...active.pending])
      this.active = undefined
    }
  }

  /**
   * Forward a client request only while its originating call is live.
   * @param method - supported client request kind.
   * @param params - SDK-validated request parameters.
   * @param callbackSignal - SDK cancellation for the specific nested request.
   * @returns the remote owner's response; throws for unbound, aborted or over-budget requests.
   */
  async request(method: LocalClientRequest['method'], params: Record<string, unknown>, callbackSignal: AbortSignal): Promise<unknown> {
    const active = this.active
    if (active?.id === undefined || this.handler === undefined) throw new Error('Local MCP callback has no originating invocation')
    const signal = AbortSignal.any([active.signal, callbackSignal])
    signal.throwIfAborted()
    if (++active.requests > this.limit) throw new Error('Local MCP client request limit exceeded')
    const operation = this.dispatch(this.handler, { method, params, service: this.config.service, invocationId: active.id, signal })
    active.pending.add(operation)
    try {
      return await operation
    } finally {
      active.pending.delete(operation)
    }
  }

  private async dispatch(handler: LocalClientRequestHandler, request: LocalClientRequest): Promise<unknown> {
    let result: unknown
    try {
      result = await handler(request)
    } catch (_error) {
      request.signal.throwIfAborted()
      throw new Error('Local MCP client request failed')
    }
    request.signal.throwIfAborted()
    return result
  }
}

type ValidationResult<T> = { value: T; issues?: undefined } | { issues: readonly unknown[] }
interface ResponseValidator<T> {
  readonly '~standard': { validate(value: unknown): ValidationResult<T> | Promise<ValidationResult<T>> }
}

/**
 * Validate a callback response without exposing its contents in diagnostics.
 * @param schema - official SDK Standard Schema validator.
 * @param value - response returned by the model or human interaction owner.
 * @returns the protocol result, or a fixed validation error.
 */
export async function checkedResponse<T>(schema: ResponseValidator<T>, value: unknown): Promise<T> {
  const parsed = await schema['~standard'].validate(value)
  if (parsed.issues !== undefined) throw new Error('Invalid local MCP client response')
  return parsed.value
}
