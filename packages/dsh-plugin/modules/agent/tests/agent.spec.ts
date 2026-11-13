import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { promptAdmissionId } from '@j-show/dsh-mcp-proxy-host'
import type { ChannelOptions } from '@j-show/mcp-proxy-protocol'
import { expect, it, onTestFinished } from 'vitest'
import { openHost } from '../../host/tests/helpers/composition.ts'
import * as ProxyAgent from '../src/index.ts'

class Model extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  beforeTool?: () => Promise<void>
  beforeSampling?: (options: GenerateOptions) => Promise<void>
  private loopCalls = 0
  async* stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.messages.some(message => message.source.kind === 'plugin' && message.source.plugin === 'mcp-proxy:sampling')) {
      await this.beforeSampling?.(options)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'nested answer' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (++this.loopCalls % 2 === 1) {
      await this.beforeTool?.()
      const id = ToolCallId(randomUUID())
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'mcp__files__read', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

function systemText(request: GenerateOptions | undefined): string {
  return request?.messages.filter(message => message.role === 'system').flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
}

it('services nested MCP sampling using the current Session model and logs its exact request and response', async () => {
  const fixture = await boot()
  const responses: unknown[] = []
  const peer = await fixture.local(async (frame, signal) => {
    const response = await peer.channel.callback(frame.id, 'sampling', {
      messages: [{ role: 'user', content: { type: 'text', text: 'nested sample' } }], maxTokens: 7,
      modelPreferences: { hints: [{ name: 'another-provider-model' }] }, systemPrompt: 'Nested task only',
    }, 2000, signal)
    responses.push(response)
    return { content: [{ type: 'text', text: 'sampled' }] }
  })
  await fixture.submit(peer.identity.endpointId)
  expect(responses).toMatchObject([{ model: 'model', content: { text: 'nested answer' } }])
  const events = fixture.agent.session.snapshotEvents().filter(event => event.type === 'mcp-proxy/sampling')
  expect(events).toMatchObject([
    { data: { kind: 'request', endpointId: peer.identity.endpointId, options: { provider: 'fixture', model: 'model',
      maxTokens: 7, system: 'Nested task only', messages: [{ role: 'user', content: [{ text: 'nested sample' }] }],
    } } },
    { data: { kind: 'chunk' } }, { data: { kind: 'chunk' } },
    { data: { kind: 'completed', response: { content: { text: 'nested answer' } } } },
  ])
  expect(fixture.model.requests).toHaveLength(3)
  const call = fixture.agent.session.snapshotEvents().find(event => event.type === 'tool/call')
  if (call?.type !== 'tool/call') throw new Error('Expected originating tool call')
  expect(events[0]?.data).toMatchObject({ callId: call.data.callId, service: 'files', tool: 'read' })
})

it('cancels and records an in-flight sampling request when its calling plugin unloads', async () => {
  const fixture = await boot()
  const entered = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  fixture.model.beforeSampling = async (options) => {
    entered.resolve(undefined)
    const signal = options.signal
    if (signal === undefined) throw new Error('Sampling signal missing')
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    cancelled.resolve(undefined)
    throw new Error('fixture-private-provider-error')
  }
  const peer = await fixture.local(async (frame, signal) => {
    await peer.channel.callback(frame.id, 'sampling', { messages: [{ role: 'user', content: { type: 'text', text: 'nested sample' } }],
      maxTokens: 8,
    }, 10000, signal)
    return { content: [] }
  })
  const running = fixture.submit(peer.identity.endpointId)
  await entered.promise
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '@j-show/dsh-mcp-proxy-agent')?.fiber
  if (fiber === undefined) throw new Error('Expected proxy agent fiber')
  await fiber.dispose()
  await cancelled.promise
  await running
  const events = fixture.agent.session.snapshotEvents().filter(event => event.type === 'mcp-proxy/sampling')
  expect(events).toMatchObject([{ data: { kind: 'request' } }, { data: { kind: 'failed', cancelled: true } }])
  expect(JSON.stringify(events)).not.toContain('fixture-private-provider-error')
})

it('keeps private provider failure text out of sampling events and the remote callback response', async () => {
  const fixture = await boot()
  fixture.model.beforeSampling = async () => { throw new Error('private-sampling-provider-value') }
  const outcomes: string[] = []
  const peer = await fixture.local(async (frame, signal) => {
    try {
      await peer.channel.callback(frame.id, 'sampling', { messages: [{ role: 'user', content: { type: 'text', text: 'nested sample' } }],
        maxTokens: 8,
      }, 2000, signal)
    } catch (error) { outcomes.push(String(error)) }
    return { content: [] }
  })
  await fixture.submit(peer.identity.endpointId)
  expect(outcomes).toHaveLength(1)
  const events = fixture.agent.session.snapshotEvents().filter(event => event.type === 'mcp-proxy/sampling')
  expect(events.at(-1)).toMatchObject({ data: { kind: 'failed', cancelled: false } })
  expect(JSON.stringify(events)).not.toContain('private-sampling-provider-value')
  expect(outcomes.join('')).not.toContain('private-sampling-provider-value')
})

it('holds tool elicitation on the server until the owning Session receives a valid human answer', async () => {
  const fixture = await boot()
  const responses: unknown[] = []
  const peer = await fixture.local(async (frame, signal) => {
    responses.push(await peer.channel.callback(frame.id, 'elicitation', { mode: 'form', message: 'Your name?',
      requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    }, 10000, signal))
    return { content: [] }
  })
  const running = fixture.submit(peer.identity.endpointId)
  await expect.poll(() => fixture.ctx.mcpProxy.elicitations.pending(fixture.agent.session.id), { timeout: 5000 }).toBeDefined()
  const pending = fixture.ctx.mcpProxy.elicitations.pending(fixture.agent.session.id)
  if (pending === undefined) throw new Error('Expected live human request')
  await fixture.ctx.mcpProxy.elicitations.answer(fixture.agent.session.id, pending.id,
    { action: 'accept', content: { name: 'Ada' } })
  await running
  expect(responses).toMatchObject([{ action: 'accept', content: { name: 'Ada' } }])
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'mcp-proxy/elicitation')).toMatchObject([
    { data: { kind: 'requested', service: 'files', tool: 'read', pending: { id: pending.id } } },
    { data: { kind: 'completed', response: { action: 'accept', content: { name: 'Ada' } } } },
  ])
})

it('keeps URL-flow authentication material in the live request and out of Session events', async () => {
  const fixture = await boot()
  const url = 'https://auth.example/start?token=private-url-token#private-url-fragment'
  const peer = await fixture.local(async (frame, signal) => {
    await peer.channel.callback(frame.id, 'elicitation', { mode: 'url', message: 'Complete sign in',
      url, elicitationId: 'sign-in',
    }, 10000, signal)
    return { content: [] }
  })
  const running = fixture.submit(peer.identity.endpointId)
  await expect.poll(() => fixture.ctx.mcpProxy.elicitations.pending(fixture.agent.session.id), { timeout: 5000 }).toBeDefined()
  const pending = fixture.ctx.mcpProxy.elicitations.pending(fixture.agent.session.id)
  if (pending === undefined || pending.params.mode !== 'url') throw new Error('Expected live URL request')
  expect(pending.params['url']).toBe(url)
  await fixture.ctx.mcpProxy.elicitations.answer(fixture.agent.session.id, pending.id, { action: 'accept' })
  await running
  const recorded = JSON.stringify(fixture.agent.session.snapshotEvents())
  expect(recorded).not.toContain('private-url-token')
  expect(recorded).not.toContain('private-url-fragment')
})

async function boot() {
  const fixture = await openHost(4, [
    { name: '@deepseek-ai/dsh-llm', module: Llm, config: () => ({}) },
    { name: '@deepseek-ai/dsh-session', module: Sessions, config: () => ({}) },
    { name: '@deepseek-ai/dsh-session-projection', module: Projections, config: () => ({}) },
    { name: '@deepseek-ai/dsh-system-prompt', module: Prompt, config: () => ({ includeHarnessIdentity: false }) },
    { name: '@deepseek-ai/dsh-tools', module: Tools, config: () => ({}) },
    { name: '@deepseek-ai/dsh-agent', module: Agents, config: () => ({}) },
    { name: '@deepseek-ai/dsh-agent-loop', module: AgentLoop, config: () => ({ agents: [] }) },
    { name: '@j-show/dsh-mcp-proxy-agent', module: ProxyAgent, config: () => ({}) },
  ], undefined, 10000)
  const model = new Model()
  fixture.ctx.llm.registerAdapter(['fixture'], model)
  const agent = await fixture.ctx.agentLoop.create(SessionId(randomUUID()), { provider: 'fixture', model: 'model' })
  async function local(onInvoke?: ChannelOptions['onInvoke']) {
    const peer = await fixture.local(undefined, onInvoke)
    const accepted = once(peer.socket, 'message')
    peer.socket.send(JSON.stringify({ v: 1, kind: 'catalog', revision: 'r1', services: [{ service: 'files',
      instructions: 'Literal {{instructions}} from the local files service.', directory: 'C:\\workspace', roots: ['file:///C:/workspace'],
    }], tools: [{ service: 'files', name: 'read', description: 'Read a local file', inputSchema: { type: 'object' } }] }))
    await accepted
    return peer
  }
  async function submit(endpoint: Awaited<ReturnType<typeof local>>['identity']['endpointId'], requestId = randomUUID()) {
    await fixture.ctx.mcpProxy.admissions.run(endpoint, () => promptAdmissionId(agent.id, requestId), async () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the local file' }],
        source: { kind: 'user', ...{ rpcId: requestId } },
      }))
    })
    await agent.whenIdle()
  }
  return { ...fixture, model, agent, local, submit }
}

it('presents local native tools before the first model request and records the initiating device', async () => {
  const fixture = await boot()
  const peer = await fixture.local()
  await fixture.submit(peer.identity.endpointId)
  expect(fixture.model.requests.length).toBeGreaterThan(0)
  expect(fixture.model.requests[0]?.tools).toMatchObject([{ name: 'mcp__files__read', description: 'Read a local file' }])
  expect(peer.frames.filter(frame => frame.kind === 'invoke')).toHaveLength(1)
  expect(systemText(fixture.model.requests[0]).split('Server files are temporary processing data')).toHaveLength(2)
  const log = fixture.agent.session.snapshotEvents()
  expect(log.find(event => event.type === 'mcp-proxy/turn')).toMatchObject({ data: { endpointId: peer.identity.endpointId } })
  expect(log.filter(event => event.type === 'tool/result')).toMatchObject([{ data: { message: { content: [{ isError: false }] } } }])
})

it('keeps local-delivery guidance on an unassociated Turn without granting local tools', async () => {
  const fixture = await boot()
  fixture.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Create a file for me' }], source: { kind: 'user' } }))
  await fixture.agent.whenIdle()
  const request = fixture.model.requests[0]
  if (request === undefined) throw new Error('Expected first model request')
  const system = systemText(request)
  expect(system).toContain('Server files are temporary processing data')
  expect(system).toContain('connect this computer')
  expect(request.tools?.some(tool => tool.name.startsWith('mcp__files__')) ?? false).toBe(false)
})

it('selects a different device for a subsequent Turn without sharing same-name tools', async () => {
  const fixture = await boot()
  const first = await fixture.local()
  const second = await fixture.local()
  await fixture.submit(first.identity.endpointId)
  await fixture.submit(second.identity.endpointId)
  expect(first.frames.filter(frame => frame.kind === 'invoke')).toHaveLength(1)
  expect(second.frames.filter(frame => frame.kind === 'invoke')).toHaveLength(1)
})

it('keeps the initiating device when another device steers an executing Turn', async () => {
  const fixture = await boot()
  const first = await fixture.local()
  const second = await fixture.local()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  fixture.model.beforeTool = async () => { entered.resolve(undefined); await release.promise }
  const running = fixture.submit(first.identity.endpointId)
  await entered.promise
  const requestId = randomUUID()
  await fixture.ctx.mcpProxy.admissions.run(second.identity.endpointId, () => promptAdmissionId(fixture.agent.id, requestId), async () => {
    fixture.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'continue here' }], source: { kind: 'user', ...{ rpcId: requestId } } }))
  })
  release.resolve(undefined)
  await running
  expect(first.frames.filter(frame => frame.kind === 'invoke')).toHaveLength(1)
  expect(second.frames.filter(frame => frame.kind === 'invoke')).toHaveLength(0)
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'mcp-proxy/turn'))
    .toMatchObject([{ data: { endpointId: first.identity.endpointId } }])
})

it('removes its listeners and leaves an unbound subsequent Turn without local tools after unload', async () => {
  const fixture = await boot()
  const peer = await fixture.local()
  await fixture.submit(peer.identity.endpointId)
  const count = fixture.agent.session.snapshotEvents().filter(event => event.type.startsWith('mcp-proxy/')).length
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '@j-show/dsh-mcp-proxy-agent')?.fiber
  if (fiber === undefined) throw new Error('Expected proxy agent fiber')
  await fiber.dispose()
  await fixture.submit(peer.identity.endpointId)
  expect(peer.frames.filter(frame => frame.kind === 'invoke')).toHaveLength(1)
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type.startsWith('mcp-proxy/'))).toHaveLength(count)
  expect(systemText(fixture.model.requests.at(-1))).not.toContain('Server files are temporary processing data')
})

it('cancels an in-flight invocation when the agent plugin unloads', async () => {
  const fixture = await boot()
  const entered = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const peer = await fixture.local(async (_frame, signal) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    stopped.resolve(undefined)
    throw new Error('cancelled local operation')
  })
  const running = fixture.submit(peer.identity.endpointId)
  await entered.promise
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '@j-show/dsh-mcp-proxy-agent')?.fiber
  if (fiber === undefined) throw new Error('Expected proxy agent fiber')
  await fiber.dispose()
  await stopped.promise
  await running
  expect(peer.frames.filter(frame => frame.kind === 'cancel')).toHaveLength(1)
  expect(fixture.agent.session.snapshotEvents().filter(event => event.type === 'tool/result'))
    .toMatchObject([{ data: { message: { content: [{ isError: true }] } } }])
})

it('preserves a device binding across a remove-and-steer queue move before the next claim', async () => {
  const fixture = await boot()
  const peer = await fixture.local()
  const requestId = randomUUID()
  const message = createUserMessage({ content: [{ type: 'text', text: 'queued input' }], source: { kind: 'user', ...{ rpcId: requestId } } })
  await fixture.ctx.mcpProxy.admissions.run(peer.identity.endpointId, () => promptAdmissionId(fixture.agent.id, requestId), async () => {
    fixture.agent.send(message, 'next-turn', false)
  })
  fixture.agent.inbox.remove(message.id)
  fixture.agent.steer(message)
  await fixture.agent.whenIdle()
  expect(peer.frames.filter(frame => frame.kind === 'invoke')).toHaveLength(1)
})
