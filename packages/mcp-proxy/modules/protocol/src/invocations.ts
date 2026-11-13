/** Connection-generation-local invocation admission and terminal settlement. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one external tool operation. */
export type InvocationId = Branded<'McpProxyInvocationId'>
/** Terminal outcome; unknown never authorizes an automatic retry. */
export type InvocationOutcome = 'succeeded' | 'failed' | 'unknown'
/** Whether the caller owns execution or must reuse the retained state. */
export interface InvocationAdmission {
  readonly execute: boolean
  readonly state: 'pending' | InvocationOutcome
}

/** Retains every admitted identity until its connection generation is discarded. */
export class InvocationLedger {
  private readonly states = new Map<InvocationId, 'pending' | InvocationOutcome>()
  private closed = false

  /** @param capacity - maximum distinct identities retained; capacity exhaustion refuses new work. */
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('invocation capacity must be a positive safe integer')
  }

  /**
   * Reserve execution once; retained identities are never automatically evicted.
   * @param id - operation identity admitted by the protocol owner.
   * @returns ownership and retained state; throws for new operations after close or capacity exhaustion.
   */
  begin(id: InvocationId): InvocationAdmission {
    const state = this.states.get(id)
    if (state !== undefined) return { execute: false, state }
    if (this.closed) throw new Error('invocation generation is closed')
    if (this.states.size >= this.capacity) throw new Error('invocation capacity exhausted')
    this.states.set(id, 'pending')
    return { execute: true, state: 'pending' }
  }

  /**
   * Retain the first terminal outcome.
   * @param id - previously admitted operation.
   * @param outcome - observed terminal state.
   * @returns true on first settlement, false for late/duplicate replies; throws for unadmitted IDs.
   */
  settle(id: InvocationId, outcome: InvocationOutcome): boolean {
    const state = this.states.get(id)
    if (state === undefined) throw new Error('invocation was not admitted')
    if (state !== 'pending') return false
    this.states.set(id, outcome)
    return true
  }

  /** Close this generation, marking pending operations unknown without reopening settled work. */
  disconnect(): void {
    this.closed = true
    for (const [id, state] of this.states) {
      if (state === 'pending') this.states.set(id, 'unknown')
    }
  }
}
