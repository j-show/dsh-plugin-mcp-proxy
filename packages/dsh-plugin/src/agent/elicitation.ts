/** Durable human request projection with invocation-owned waiting on the host. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProxyCallbackRequest } from '@jshow/app-mcp-proxy/protocol'
import type { default as McpProxyHost, PendingElicitation, ProxySelection } from '../host/index.ts'
import type { CallbackCorrelation } from './types.ts'

/** Request, answer or explicit failure of one tool-initiated human continuation. */
type RecordedPending = Omit<PendingElicitation, 'params'> & {
  readonly params: Exclude<PendingElicitation['params'], { mode: 'url' }> | { readonly mode: 'url'; readonly message: string }
}
/** Durable request and outcome without URL-flow authentication material. */
export type ElicitationEvent = CallbackCorrelation & (
  | { readonly kind: 'requested'; readonly pending: RecordedPending }
  | { readonly kind: 'completed'; readonly response: Record<string, unknown> }
  | { readonly kind: 'failed'; readonly reason: 'cancelled' | 'expired' | 'failed' }
)
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Invocation-owned human request and terminal response; closing a page does not cancel it. */
    'mcp-proxy/elicitation': ElicitationEvent
  }
}

/**
 * Keep a tool's human wait on the server and record its Session projection.
 * @param agent - exact live invoking Agent.
 * @param store - human request owner captured by the declaring plugin's injection.
 * @param selection - initiating connection generation.
 * @param request - parent-correlated MCP callback.
 * @param owner - durable Agent tool call and raw local tool identities.
 * @param signal - originating tool/callback cancellation.
 * @returns the schema-validated human response, independent of a page lifetime.
 */
export async function elicitForInvocation(
  agent: Agent, store: McpProxyHost['elicitations'], selection: ProxySelection, request: ProxyCallbackRequest,
  owner: Pick<CallbackCorrelation, 'callId' | 'service' | 'tool'>, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const correlation = { ...owner, id: request.id, parent: request.parent,
    endpointId: selection.endpointId, generation: selection.generation,
  }
  try {
    const response = await store.ask(agent.session.id, request.params, signal, (pending) => {
      const recorded: RecordedPending = { ...pending, params: pending.params.mode === 'url'
        ? { mode: 'url', message: pending.params.message } : pending.params,
      }
      agent.session.append('mcp-proxy/elicitation', { ...correlation, kind: 'requested', pending: recorded })
    })
    signal.throwIfAborted()
    agent.session.append('mcp-proxy/elicitation', { ...correlation, kind: 'completed', response })
    return response
  } catch (error) {
    const reason = signal.aborted ? 'cancelled'
      : error instanceof Error && 'code' in error && error.code === 'expired' ? 'expired' : 'failed'
    agent.session.append('mcp-proxy/elicitation', { ...correlation, kind: 'failed', reason })
    throw new Error('MCP elicitation did not complete')
  }
}
