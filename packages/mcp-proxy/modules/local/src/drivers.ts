/** Official-SDK adapters for local stdio, Streamable HTTP and legacy SSE services. */
import { createRequire } from 'node:module'
import { Client, StreamableHTTPClientTransport, specTypeSchemas, type Tool } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport as LegacyStdioTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport as LegacyHttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport as LegacyTransport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CreateMessageRequestSchema, CreateMessageResultSchema, ElicitRequestSchema, ElicitResultSchema, ListRootsRequestSchema,
  ListToolsResultSchema, type Tool as LegacyTool } from '@modelcontextprotocol/sdk/types.js'
import type { InvocationId } from '@j-show/mcp-proxy-protocol'
import type { LocalServiceConfig } from './config.ts'
import { CallbackOwner, checkedResponse, type LocalClientRequestHandler } from './callbacks.ts'
import { DriverLifetime } from './lifetime.ts'
import { LegacyCancellation } from './legacy-cancellation.ts'
import { callLegacyTool } from './legacy-tasks.ts'
import { LegacyTaskScope } from './legacy-task-scope.ts'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** Explicit runtime limits shared by service adapters. */
export interface LocalOptions {
  readonly maxServices: number
  readonly maxFrameBytes: number
  readonly maxDiscoveryPages: number
  readonly startupTimeoutMs: number
  readonly callTimeoutMs: number
  readonly maxClientRequests: number
  readonly maxClientRequestRecords: number
  readonly taskCancelTimeoutMs: number
}

/** Private normalized service driver; returned JSON is validated by the pool. */
export interface LocalDriver {
  readonly config: LocalServiceConfig
  readonly connected: boolean
  instructions(): string | undefined
  info(): unknown
  tools(signal?: AbortSignal): Promise<unknown[]>
  call(name: string, args: Record<string, unknown>, signal: AbortSignal, tool: unknown, invocationId?: InvocationId): Promise<unknown>
  close(): Promise<void>
}

/**
 * Connect one downstream service; failed startup closes its owned SDK transport.
 * @param config - validated local service entry.
 * @param options - resolved deployment limits.
 * @param requests - parent-correlated model/human callback owner.
 * @param environment - already scrubbed inherited process environment.
 * @param signal - startup cancellation, including negotiation and discovery.
 * @returns connected SDK driver, or a startup failure after cleanup.
 */
export async function openDriver(
  config: LocalServiceConfig, options: LocalOptions, requests: LocalClientRequestHandler | undefined,
  environment: Record<string, string>, signal?: AbortSignal,
): Promise<LocalDriver> {
  if (config.transport === 'sse') return openLegacy(config, options, requests, environment, signal)
  const callbacks = new CallbackOwner(config, options.maxClientRequests, requests)
  const client = new Client({ name: 'dsh-mcp-proxy', version }, {
    capabilities: { roots: {}, ...(requests === undefined ? {} : { sampling: {}, elicitation: { form: {}, url: {} } }) },
    versionNegotiation: { mode: 'auto' }, listMaxPages: options.maxDiscoveryPages,
    inputRequired: { maxRounds: options.maxClientRequests },
  })
  client.setRequestHandler('roots/list', async () => callbacks.roots())
  if (requests !== undefined) {
    client.setRequestHandler('sampling/createMessage', async (request, context) => checkedResponse(specTypeSchemas.CreateMessageResult,
      await callbacks.request('sampling', { ...request.params }, context.mcpReq.signal)))
    client.setRequestHandler('elicitation/create', async (request, context) => checkedResponse(specTypeSchemas.ElicitResult,
      await callbacks.request('elicitation', { ...request.params }, context.mcpReq.signal)))
  }
  const transport = config.transport === 'stdio'
    ? new StdioClientTransport({ command: config.command, args: [...config.args],
      env: { ...environment, ...config.env }, cwd: config.cwd })
    : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { ...config.headers } } })
  const lifetime = new DriverLifetime(client, transport)
  try {
    const connect = () => client.connect(transport, { timeout: options.startupTimeoutMs, ...(signal === undefined ? {} : { signal }) })
    if (signal === undefined) await connect()
    else await lifetime.run(signal, connect)
    lifetime.ready()
    if (client.getProtocolEra() === 'legacy') {
      await lifetime.close()
      signal?.throwIfAborted()
      return await openLegacy(config, options, requests, environment, signal)
    }
  } catch (error) {
    await lifetime.close()
    throw error
  }
  return {
    config,
    get connected() { return lifetime.connected },
    instructions: () => client.getInstructions(),
    info: () => client.getServerVersion(),
    tools: async discoverySignal => (await client.listTools(undefined, {
      cacheMode: 'refresh', timeout: options.callTimeoutMs, ...(discoverySignal === undefined ? {} : { signal: discoverySignal }),
    })).tools,
    call: (name, args, signal, tool, id) => callbacks.run(id, signal, owned => lifetime.run(owned, () =>
      client.callTool({ name, arguments: args }, { signal: owned, timeout: options.callTimeoutMs, toolDefinition: tool as Tool }))),
    close: () => lifetime.close(),
  }
}

async function openLegacy(
  config: LocalServiceConfig, options: LocalOptions, requests: LocalClientRequestHandler | undefined, environment: Record<string, string>,
  signal?: AbortSignal,
): Promise<LocalDriver> {
  const callbacks = new CallbackOwner(config, options.maxClientRequests, requests)
  const client = new LegacyClient({ name: 'dsh-mcp-proxy', version }, {
    capabilities: { roots: {}, ...(requests === undefined ? {} : { sampling: {}, elicitation: { form: {}, url: {} } }) },
  })
  const cancellation = new LegacyCancellation(options.maxClientRequestRecords, options.maxFrameBytes)
  const taskScope = new LegacyTaskScope()
  client.setRequestHandler(ListRootsRequestSchema, async () => callbacks.roots())
  if (requests !== undefined) {
    client.setRequestHandler(CreateMessageRequestSchema, async (request, context) => {
      if (context.taskId !== taskScope.id) throw new Error('MCP sampling task does not match its originating invocation')
      const result = await cancellation.run(context.requestId, context.signal,
        signal => callbacks.request('sampling', { ...request.params }, signal), 'sampling', callbacks.parentId())
      const parsed = CreateMessageResultSchema.safeParse(result)
      if (!parsed.success) throw new Error('Invalid local MCP client response')
      return parsed.data
    })
    client.setRequestHandler(ElicitRequestSchema, async (request, context) => {
      if (context.taskId !== taskScope.id) throw new Error('MCP elicitation task does not match its originating invocation')
      const result = await cancellation.run(context.requestId, context.signal,
        signal => callbacks.request('elicitation', { ...request.params }, signal), 'elicitation', callbacks.parentId())
      const parsed = ElicitResultSchema.safeParse(result)
      if (!parsed.success) throw new Error('Invalid local MCP client response')
      return parsed.data
    })
  }
  // SDK HTTP transports expose an undefined sessionId getter before initialization.
  const nativeTransport = (config.transport === 'stdio'
    ? new LegacyStdioTransport({ command: config.command, args: [...config.args], env: { ...environment, ...config.env }, cwd: config.cwd })
    : config.transport === 'streamable-http'
      ? new LegacyHttpTransport(new URL(config.url), { requestInit: { headers: { ...config.headers } } })
      : new SSEClientTransport(new URL(config.url), {
        requestInit: { headers: { ...config.headers } },
        eventSourceInit: { fetch: (input, init) => fetch(input, {
          ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...config.headers },
        }) },
      })) as LegacyTransport
  const transport = cancellation.wrap(nativeTransport, taskScope)
  const lifetime = new DriverLifetime(client, transport)
  try {
    const connect = () => client.connect(transport, { timeout: options.startupTimeoutMs, ...(signal === undefined ? {} : { signal }) })
    if (signal === undefined) await connect()
    else await lifetime.run(signal, connect)
    lifetime.ready()
  } catch (error) {
    await lifetime.close()
    throw error
  }
  return {
    config,
    get connected() { return lifetime.connected },
    instructions: () => client.getInstructions(),
    info: () => client.getServerVersion(),
    tools: async (discoverySignal) => {
      if (client.getServerCapabilities()?.tools === undefined) return []
      // SDK1 replaces its metadata cache per page; this driver retains every descriptor and validates selected outputs.
      const tools: unknown[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < options.maxDiscoveryPages; page++) {
        const result = await client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, ListToolsResultSchema, {
          timeout: options.callTimeoutMs, ...(discoverySignal === undefined ? {} : { signal: discoverySignal }),
        })
        tools.push(...result.tools)
        if (result.nextCursor === undefined) return tools
        if (cursors.has(result.nextCursor)) throw new Error('Local MCP discovery cursor repeated')
        cursors.add(result.nextCursor)
        cursor = result.nextCursor
      }
      throw new Error('Local MCP discovery page limit exceeded')
    },
    call: (_name, args, signal, tool, id) => callbacks.run(id, signal, owned =>
      callLegacyTool(client, lifetime, tool as LegacyTool, args, owned, options, taskScope)),
    close: () => lifetime.close(),
  }
}
