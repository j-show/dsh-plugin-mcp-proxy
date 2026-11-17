/** Durable input and Turn device associations owned by the MCP proxy agent consumer. */
import type { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { EndpointId, CallbackId, InvocationId, GenerationId } from '@jshow/app-mcp-proxy/protocol'
import type { PromptAdmissionId, ProxySelection } from '@jshow/dsh-plugin-mcp-proxy/host'

/** Durable link between a nested request, local connection and recorded Agent tool call. */
export interface CallbackCorrelation {
  readonly id: CallbackId
  readonly parent: InvocationId
  readonly endpointId: EndpointId
  readonly generation: GenerationId
  readonly callId: ToolCallId
  readonly service: string
  readonly tool: string
}

/** An accepted browser input's one-use association and its later retirement. */
export type InputBindingEvent =
  | { readonly kind: 'bound'; readonly messageId: MessageId; readonly admission: PromptAdmissionId; readonly endpointId: EndpointId }
  | { readonly kind: 'released'; readonly messageId: MessageId; readonly reason: 'claimed' | 'discarded' }

/** Exact catalog and connection pinned before one Turn's first model request. */
export type TurnBindingEvent =
  | ({ readonly kind: 'ready'; readonly turn: number; readonly inputId: MessageId } & ProxySelection)
  | { readonly kind: 'unavailable'; readonly turn: number; readonly inputId: MessageId; readonly endpointId: EndpointId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Accepted browser input association or retirement; never contains cookie authority. */
    'mcp-proxy/input': InputBindingEvent
    /** Turn-owned local tool directory and connection selection, or explicit unavailability. */
    'mcp-proxy/turn': TurnBindingEvent
  }
}
