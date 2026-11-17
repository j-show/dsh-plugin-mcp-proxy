/** Agent consumer for local MCP browser associations. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type AttachmentStore from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { ProxyCallError } from '@jshow/app-mcp-proxy/protocol'
import { promptAdmissionId, type ProxySelection } from '@jshow/dsh-plugin-mcp-proxy/host'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { InputBindingEvent, TurnBindingEvent } from './types.ts'
import { sampleForInvocation } from './sampling.ts'
import { elicitForInvocation } from './elicitation.ts'

export type { InputBindingEvent, TurnBindingEvent } from './types.ts'
export type { SamplingEvent } from './sampling.ts'
export type { ElicitationEvent } from './elicitation.ts'

/** Stable Cordis plugin name. */
export const name = 'mcp-proxy-agent'
/** Existing services providing input lifecycle and tool projection. */
export const inject = ['agents', 'mcpProxy', 'tools', 'systemPrompt', 'llm']

/** Deployment budget for the complete attributed local guidance. */
export interface Config {
  /** Maximum attributed local MCP instruction size in bytes. */
  readonly maxInstructionBytes: number
  /** Maximum output tokens for a nested sampling request. */
  readonly maxSamplingTokens: number
}
/** Validated attributed instruction limit. */
export const Config: z<Config> = z.object({ maxInstructionBytes: z.natural().min(1).default(32768),
  maxSamplingTokens: z.natural().min(1).default(4096),
})

type BoundInput = Extract<InputBindingEvent, { kind: 'bound' }>
type Ready = Extract<TurnBindingEvent, { kind: 'ready' }>
type State =
  | { readonly kind: 'idle' | 'disposed' }
  | { readonly kind: 'unbound'; readonly turn: number }
  | { readonly kind: 'preparing'; readonly turn: number; readonly input: BoundInput }
  | { readonly kind: 'failed'; readonly turn: number }
  | Ready

const DELIVERY_GUIDANCE = 'Create and edit files delivered to the user through local MCP tools. Server files are temporary processing data. '
  + 'Use the services identified by local-computer directory guidance for delivery. If no suitable local tools are available, '
  + 'ask the user to connect this computer in Web Settings or configure the required local MCP; do not substitute a server file.'

function toolName(service: string, rawName: string): string {
  const original = `mcp__${service}__${rawName}`
  const normalized = original.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === original && original.length <= 64) return original
  const suffix = createHash('sha256').update([service, rawName].join('\0')).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${suffix}`
}

function guidance(binding: ProxySelection): string {
  return [
    'These MCP services run on the local computer. The directories below belong to that computer, not the server.',
    ...binding.catalog.services.map(service => [
      `### MCP server: ${service.service}`,
      ...(service.directory === undefined ? [] : [`Working directory: ${JSON.stringify(service.directory)}`]),
      ...(service.roots === undefined ? [] : [`Roots: ${JSON.stringify(service.roots)}`]),
      ...(service.instructions === undefined ? [] : [service.instructions]),
    ].join('\n\n')),
  ].join('\n\n')
}

/**
 * Record browser input authority and install local tools at the existing pre-assembly claim point.
 * @param ctx - host composition context.
 * @param config - complete local guidance budget.
 */
export function apply(ctx: Context, config: Config): void {
  const spec = Config(config)
  const deliveryBytes = Buffer.byteLength(DELIVERY_GUIDANCE)
  if (deliveryBytes > spec.maxInstructionBytes) throw new Error('MCP proxy instruction budget cannot fit its delivery guidance')
  let attachments: AttachmentStore | undefined
  ctx.inject(['attachments'], (scope) => {
    attachments = scope.attachments
    scope.effect(() => () => { attachments = undefined })
  })
  const attached = new Map<Agent, () => void>()
  function attach(agent: Agent): void {
    if (attached.has(agent)) return
    const dispose = ctx.effect(() => {
      const inputs = new Map<MessageId, BoundInput>()
      const stop = new AbortController()
      const calls = new Set<Promise<unknown>>()
      const releaseDelivery = agent.ctx.systemPrompt.section({ name: 'mcp-proxy:delivery',
        order: agent.ctx.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false, text: DELIVERY_GUIDANCE,
      })
      let state: State = { kind: 'idle' }
      let contributions: (() => void)[] = []
      let definitions = new Map<string, ToolDefinition>()
      const clear = (): void => {
        for (const release of contributions.reverse()) release()
        contributions = []
        definitions.clear()
      }
      const fail = (): never => { throw new ProxyCallError('unavailable', 'Selected local MCP tools are unavailable') }
      const install = (binding: Ready): void => {
        const text = guidance(binding)
        if (Buffer.byteLength(text) + deliveryBytes > spec.maxInstructionBytes) fail()
        const aliases = binding.catalog.services.map(service => `mcp__${service.service}__`)
        if (agent.ctx.tools.schemas(agent).some(tool => aliases.some(prefix => tool.name.startsWith(prefix)))) fail()
        const next = new Map<string, ToolDefinition>()
        for (const tool of binding.catalog.tools) {
          const name = toolName(tool.service, tool.name)
          if (next.has(name)) fail()
          const definition = createMcpToolDefinition(agent.ctx, {
            name, rawName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
            call: async (args, execution) => {
              if (state.kind !== 'ready' || state !== binding || execution.agent !== agent
                || ctx.agents.get(agent.id) !== agent) fail()
              const call = ctx.mcpProxy.invoke(binding, {
                revision: binding.catalog.revision, service: tool.service, name: tool.name, args,
              }, AbortSignal.any([execution.signal, stop.signal]), async (request, signal) => {
                if (state !== binding || ctx.agents.get(agent.id) !== agent) fail()
                const owner = { callId: execution.callId, service: tool.service, tool: tool.name }
                return request.method === 'sampling'
                  ? sampleForInvocation(agent, binding, request, owner, attachments, spec.maxSamplingTokens, signal)
                  : elicitForInvocation(agent, ctx.mcpProxy.elicitations, binding, request, owner, signal)
              })
              calls.add(call)
              try { return await call } finally { calls.delete(call) }
            },
          })
          next.set(name, { ...definition, presentCall: args => ({ card: 'generic', title: `${tool.service}: ${tool.name}`, rawInput: args }) })
        }
        try {
          for (const definition of next.values()) contributions.push(agent.ctx.tools.register(definition))
          contributions.push(agent.ctx.systemPrompt.section({ name: 'mcp-proxy:local',
            order: agent.ctx.systemPrompt.getSectionOrder('MCP_SERVERS'), interpolate: false, text,
          }))
          definitions = next
        } catch (error) { clear(); throw error }
      }
      for (const event of agent.session.snapshotEvents()) {
        if (event.type === 'mcp-proxy/input') {
          if (event.data.kind === 'bound') inputs.set(event.data.messageId, event.data)
          else inputs.delete(event.data.messageId)
        } else if (event.type === 'mcp-proxy/turn' && event.data.kind === 'ready') state = event.data
        else if (event.type === 'turn/end') state = { kind: 'idle' }
      }
      if (state.kind === 'ready') {
        try { install(state) } catch (_error) { state = { kind: 'failed', turn: state.turn } }
      }
      const releaseInput = (messageId: MessageId, reason: 'claimed' | 'discarded'): void => {
        if (!inputs.has(messageId)) return
        agent.session.append('mcp-proxy/input', { kind: 'released', messageId, reason })
        inputs.delete(messageId)
      }
      const listeners = [
        agent.ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
          if (subject !== agent || message.source.kind !== 'user' || !('rpcId' in message.source)
            || typeof message.source.rpcId !== 'string') return
          const admission = promptAdmissionId(agent.id, message.source.rpcId)
          const previous = inputs.get(message.id)
          if (previous?.admission === admission) return
          if (previous !== undefined) releaseInput(message.id, 'discarded')
          const endpointId = ctx.mcpProxy.admissions.claim(admission)
          if (endpointId === undefined) return
          const binding: BoundInput = { kind: 'bound', messageId: message.id, admission, endpointId }
          agent.session.append('mcp-proxy/input', binding)
          inputs.set(message.id, binding)
        }),
        agent.ctx.on('session/event', (session, event) => {
          if (session !== agent.session) return
          if (event.type === 'turn/start') {
            const message = agent.inbox.nextTurn[0] ?? agent.inbox.nextStep[0]
            const input = message === undefined ? undefined : inputs.get(message.id)
            state = input === undefined ? { kind: 'unbound', turn: event.data.turn } : { kind: 'preparing', turn: event.data.turn, input }
          } else if (event.type === 'turn/end') { clear(); state = { kind: 'idle' } }
        }),
        agent.ctx.on('agent/inbox/discarded', ({ agent: subject, message }) => {
          if (subject !== agent || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(input => input.id === message.id)) return
          const binding = inputs.get(message.id)
          queueMicrotask(() => {
            if (state.kind === 'disposed' || binding === undefined || inputs.get(message.id) !== binding) return
            const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(input => input.id === message.id)
            if (pending?.source.kind === 'user' && 'rpcId' in pending.source && typeof pending.source.rpcId === 'string'
              && promptAdmissionId(agent.id, pending.source.rpcId) === binding.admission) return
            releaseInput(message.id, 'discarded')
          })
        }),
        agent.ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
          if (subject !== agent) return
          if (state.kind === 'preparing' && state.turn === turn && state.input.messageId === message.id) {
            const input = state.input
            try {
              const selected = ctx.mcpProxy.select(input.endpointId)
              if (selected === undefined) {
                agent.session.append('mcp-proxy/turn', { kind: 'unavailable', turn, inputId: message.id, endpointId: input.endpointId })
                return fail()
              }
              const binding: Ready = { kind: 'ready', turn, inputId: message.id, ...selected }
              agent.session.append('mcp-proxy/turn', binding)
              releaseInput(message.id, 'claimed')
              install(binding)
              state = binding
            } catch (_error) { clear(); state = { kind: 'failed', turn } }
          } else releaseInput(message.id, 'claimed')
        }),
        agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
          if (context.scope !== agent) return next()
          if (state.kind === 'failed' || state.kind === 'preparing') fail()
          const result = await next()
          if (state.kind === 'ready' && [...definitions.keys()].some(name => !result.tools.some(tool => tool.name === name))) fail()
          return result
        }),
        agent.ctx.on('agent/pre-step', async ({ agent: subject, turn }, next) => {
          if (subject === agent && (state.kind === 'failed' || state.kind === 'preparing'
            || (state.kind === 'ready' && state.turn !== turn))) fail()
          return next()
        }),
      ]
      return async () => {
        state = { kind: 'disposed' }
        stop.abort()
        releaseDelivery()
        clear()
        for (const listener of listeners) listener()
        inputs.clear()
        await Promise.allSettled(calls)
      }
    })
    attached.set(agent, () => { void dispose(); attached.delete(agent) })
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => { attached.get(agent)?.() })
  for (const agent of ctx.agents.list()) attach(agent)
}
