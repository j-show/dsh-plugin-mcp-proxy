/** Request-local association authority; inherited asynchronous work cannot reuse a closed request. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { EndpointId } from '@jshow/app-mcp-proxy/protocol'
import { AsyncLocalStorage } from 'node:async_hooks'

/** Exact Session/request pair admitted from one Web prompt envelope. */
export type PromptAdmissionId = Branded<'McpProxyPromptAdmissionId'>

/**
 * Construct the correlation key without interpreting either component.
 * @param sessionId - Session identity from the admitted request or accepted Agent input.
 * @param requestId - prompt identity from the same request or input.
 * @returns lossless tuple identity used only for request correlation.
 */
export function promptAdmissionId(sessionId: string, requestId: string): PromptAdmissionId {
  return JSON.stringify([sessionId, requestId]) as PromptAdmissionId
}

interface Admission {
  readonly endpoint: EndpointId
  readonly expected: () => PromptAdmissionId | undefined
  open: boolean
  claimed: boolean
}

/** Own one-use endpoint authority for the exact accepted input of a Web request. */
export class ProxyAdmissions {
  private readonly requests = new AsyncLocalStorage<Admission>()
  /**
   * Scope one admission to its initiating authenticated Web delegation.
   * @param endpoint - verified browser grant's endpoint.
   * @param expected - reads the identity after the unchanged API carrier finishes reading its envelope.
   * @param operation - original Web request delegation.
   * @returns the delegated operation's original outcome.
   */
  async run<T>(endpoint: EndpointId, expected: () => PromptAdmissionId | undefined, operation: () => Promise<T>): Promise<T> {
    const admission: Admission = { endpoint, expected, open: true, claimed: false }
    return this.requests.run(admission, async () => {
      try { return await operation() } finally { admission.open = false }
    })
  }

  /**
   * Consume admission for the exact Session and input tuple.
   * @param identity - exact accepted Session/request pair.
   * @returns endpoint once, only inside its open request.
   */
  claim(identity: PromptAdmissionId): EndpointId | undefined {
    const admission = this.requests.getStore()
    if (admission === undefined || !admission.open || admission.claimed || admission.expected() !== identity) return undefined
    admission.claimed = true
    return admission.endpoint
  }
}
