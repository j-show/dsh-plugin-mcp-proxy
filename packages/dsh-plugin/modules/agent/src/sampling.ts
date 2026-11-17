/** Invocation-owned auxiliary model calls with durable inputs and stream output. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createAssistantMessage, createUserMessage, type ContentBlock, type GenerateOptions,
  type Message, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ProxyCallbackRequest } from '@jshow/app-mcp-proxy/protocol'
import type { ProxySelection } from '@jshow/dsh-plugin-mcp-proxy/host'
import type AttachmentStore from '@deepseek-ai/dsh-attachment'
import { specTypeSchemas } from '@modelcontextprotocol/client'
import type { CallbackCorrelation } from './types.ts'

/** Exact model-visible auxiliary request and output, without live authority or credentials. */
export type SamplingEvent = CallbackCorrelation & (
  | { readonly kind: 'request'; readonly options: Omit<GenerateOptions, 'signal'> }
  | { readonly kind: 'chunk'; readonly chunk: StreamChunk }
  | { readonly kind: 'failed'; readonly cancelled: boolean }
  | { readonly kind: 'completed'; readonly response: Record<string, unknown> }
)
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Invocation-owned sampling input, model stream and terminal outcome. */
    'mcp-proxy/sampling': SamplingEvent
  }
}

/**
 * Run sampling through the Session's current model without recursively entering its Agent loop.
 * @param agent - exact live calling Agent.
 * @param selection - immutable initiating tool selection.
 * @param request - parent-correlated validated aggregation callback.
 * @param owner - durable initiating tool call and original local service/tool identities.
 * @param attachments - explicitly injected image store, absent for text-only deployments.
 * @param maxTokens - deployment cap for one sampling response.
 * @param signal - parent and callback cancellation.
 * @returns an MCP sampling response from the configured Session model.
 */
export async function sampleForInvocation(
  agent: Agent, selection: ProxySelection, request: ProxyCallbackRequest,
  owner: { readonly callId: ToolCallId; readonly service: string; readonly tool: string },
  attachments: AttachmentStore | undefined, maxTokens: number, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  const parsed = specTypeSchemas.CreateMessageRequestParams['~standard'].validate(request.params)
  if (parsed.issues !== undefined) throw new Error('Invalid MCP sampling request')
  const params = parsed.value
  if ((params.tools?.length ?? 0) > 0 || params.toolChoice !== undefined) throw new Error('Sampling tools are not negotiated')
  const latest = agent.session.requestHeader()?.config
  const provider = latest?.provider ?? agent.options.provider
  const model = latest?.model ?? agent.options.model
  if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) {
    throw new Error('Session sampling model unavailable')
  }
  const messages: Message[] = []
  for (const message of params.messages) {
    const content: ContentBlock[] = []
    for (const part of Array.isArray(message.content) ? message.content : [message.content]) {
      signal.throwIfAborted()
      if (part.type === 'text') content.push({ type: 'text', text: part.text })
      else if (part.type === 'image') {
        if (attachments === undefined) throw new Error('Sampling image storage unavailable')
        const mediaType = part.mimeType
        if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif') {
          throw new Error('Unsupported sampling image media type')
        }
        const data = Buffer.from(part.data, 'base64')
        if (data.toString('base64') !== part.data) throw new Error('Invalid sampling image encoding')
        const attachment = await attachments.saveImage({ data, mediaType })
        signal.throwIfAborted()
        content.push({ type: 'image', attachment })
      } else throw new Error('Unsupported sampling content')
    }
    messages.push(message.role === 'user'
      ? createUserMessage({ content, source: { kind: 'plugin', plugin: 'mcp-proxy:sampling' } })
      : createAssistantMessage({ content, source: { provider, model } }))
  }
  const inherited = latest ?? { provider, model,
    ...(agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: agent.options.reasoningEffort }),
    ...(agent.options.maxTokens === undefined ? {} : { maxTokens: agent.options.maxTokens }),
  }
  const options: Omit<GenerateOptions, 'signal'> = { ...inherited, provider, model, messages, sessionId: agent.session.id,
    maxTokens: Math.min(params.maxTokens, maxTokens, inherited.maxTokens ?? maxTokens),
    ...(params.systemPrompt === undefined ? {} : { system: params.systemPrompt }),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.stopSequences === undefined ? {} : { stop: params.stopSequences }),
  }
  const correlation = { ...owner, id: request.id, parent: request.parent,
    endpointId: selection.endpointId, generation: selection.generation,
  }
  agent.session.append('mcp-proxy/sampling', { ...correlation, kind: 'request', options })
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of agent.ctx.llm.stream({ ...structuredClone(options), signal })) {
      signal.throwIfAborted()
      const recorded: StreamChunk = chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
        ? { type: 'finish', reason: { kind: chunk.reason.kind,
          failure: { code: 'MCP_SAMPLING_FAILED', message: 'MCP sampling did not complete' },
        } } : chunk
      agent.session.append('mcp-proxy/sampling', { ...correlation, kind: 'chunk', chunk: recorded })
      assembler.push(recorded)
    }
    signal.throwIfAborted()
    const blocks = assembler.blocks()
    if (assembler.finish?.kind !== 'stop' && assembler.finish?.kind !== 'max-tokens') throw new Error('Sampling did not finish')
    if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) throw new Error('Unsupported sampling model output')
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    const response = { role: 'assistant', model, content: { type: 'text', text },
      stopReason: assembler.finish.kind === 'max-tokens' ? 'maxTokens' : 'endTurn',
    }
    agent.session.append('mcp-proxy/sampling', { ...correlation, kind: 'completed', response })
    return response
  } catch (_error) {
    // Provider failures may contain credentials, request bodies or private transport details.
    agent.session.append('mcp-proxy/sampling', { ...correlation, kind: 'failed', cancelled: signal.aborted })
    throw new Error('MCP sampling did not complete')
  }
}
