/** Local invocation ownership shared by independent authenticated DSH channels. */
import type { GenerationId, DshConnectionId, InvocationId, ProxyFrame } from '@j-show/mcp-proxy-protocol'
import type { LocalClientRequest } from './callbacks.ts'
import { randomUUID } from 'node:crypto'

/** Exact admitted DSH channel; never replaced by a GUI selection. */
export interface LocalDshOwner {
  readonly connectionId: DshConnectionId
  readonly generation: GenerationId
  readonly live: () => boolean
  readonly callback: (request: LocalClientRequest) => Promise<unknown>
}

/** Isolate remote request identities before they enter a shared MCP client. */
export class LocalInvocationRoutes {
  private readonly bindings = new Map<InvocationId, { owner: LocalDshOwner; frame: Extract<ProxyFrame, { kind:'invoke' }>; signal: AbortSignal; assert: () => void }>()
  private readonly remote = new Set<string>()
  /** @param capacity - maximum retained local invocation owners. */
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Invalid local routing capacity')
  }
  /**
   * Bind a local invocation to its originating DSH connection.
   * @param owner - authenticated origin channel.
   * @param frame - admitted invocation.
   * @param signal - call lifetime.
   * @param execute - local operation.
   * @returns the original caller's result.
   */
  async run<T>(owner: LocalDshOwner, frame: Extract<ProxyFrame, { kind: 'invoke' }>, signal: AbortSignal,
    execute: (id: InvocationId, assertOwner: () => void) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const key = JSON.stringify([owner.connectionId, owner.generation, frame.id])
    if (!owner.live() || owner.generation !== frame.generation || this.remote.has(key) || this.bindings.size >= this.capacity) {
      throw new Error('Local MCP invocation owner unavailable')
    }
    const id = randomUUID() as InvocationId
    const binding = { owner, frame: structuredClone(frame), signal, assert: () => {
      signal.throwIfAborted()
      if (!owner.live() || this.bindings.get(id) !== binding) throw new Error('Local MCP invocation owner unavailable')
    } }
    this.bindings.set(id, binding)
    this.remote.add(key)
    try { binding.assert(); const result = await execute(id, binding.assert); binding.assert(); return result }
    finally { this.bindings.delete(id); this.remote.delete(key) }
  }
  /**
   * Route a callback through its original DSH invocation owner.
   * @param request - local MCP callback.
   * @returns the response from its exact remote parent.
   */
  async request(request: LocalClientRequest): Promise<unknown> {
    const binding = this.bindings.get(request.invocationId)
    if (binding === undefined || binding.frame.service !== request.service) throw new Error('Local MCP callback owner unavailable')
    binding.assert()
    const signal = AbortSignal.any([request.signal, binding.signal])
    signal.throwIfAborted()
    const result = await binding.owner.callback({ ...request, invocationId: binding.frame.id, signal })
    binding.assert()
    signal.throwIfAborted()
    return result
  }
}
