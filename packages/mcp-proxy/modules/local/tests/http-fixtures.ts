import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createMcpHandler, inputRequired, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema, GetTaskRequestSchema, CreateTaskResultSchema, RELATED_TASK_META_KEY } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'
import { z } from 'zod'

export async function httpFixture(legacy: boolean, options: {
  blockDiscovery?: boolean
  holdAfterCallback?: boolean
  legacyProtocol?: boolean
  taskMode?: 'complete' | 'wait' | 'sample' | 'batched' | 'foreign-task' | 'error' | 'bad-output'
} = {}) {
  const observed: Array<string | undefined> = []
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const disconnected = Promise.withResolvers<undefined>()
  const callbackStopped = Promise.withResolvers<undefined>()
  const callbackStop = new AbortController()
  let discoveryStarted = false
  const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>()
  const httpSessions = new Map<string, StreamableHTTPServerTransport>()
  const httpServers = new Set<Server>()
  const taskStores = new Set<InMemoryTaskStore>()
  const taskCreated = Promise.withResolvers<undefined>()
  const taskCancelled = Promise.withResolvers<undefined>()
  const taskPolled = Promise.withResolvers<undefined>()
  const taskWork = new Set<Promise<void>>()
  const batchedCallbacks = new Map<Server, (id: string) => void>()
  let taskCalls = 0
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'proxy-http-fixture', version: '1' }, { instructions: 'HTTP fixture instructions.' })
    server.registerTool('ping', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'pong' }], _meta: { local: true } }))
    server.registerTool('wait', { inputSchema: z.object({}) }, async () => {
      entered.resolve(undefined)
      await release.promise
      return { content: [] }
    })
    server.registerTool('interactive', { inputSchema: z.object({}) }, async (_args, context) => {
      if (context.mcpReq.requestState() !== undefined) {
        if (context.mcpReq.requestState() !== 'fixture-state') throw new Error('Unexpected continuation')
        return { content: [], structuredContent: z.record(z.string(), z.json()).parse(context.mcpReq.inputResponses) }
      }
      return inputRequired({ requestState: 'fixture-state', inputRequests: {
        roots: { method: 'roots/list' },
        sampling: { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }], maxTokens: 16 } },
        elicitation: { method: 'elicitation/create', params: { mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
      } })
    })
    if (options.blockDiscovery) server.server.setRequestHandler('tools/list', async () => {
      discoveryStarted = true
      await release.promise
      return { tools: [] }
    })
    return server
  })
  const modern = toNodeHandler(handler)
  function legacyServer(): Server {
    class TaskStore extends InMemoryTaskStore {
      override async updateTaskStatus(...args: Parameters<InMemoryTaskStore['updateTaskStatus']>) {
        await super.updateTaskStatus(...args)
        if (args[1] === 'cancelled') taskCancelled.resolve(undefined)
      }
    }
    const store = new TaskStore()
    taskStores.add(store)
    const server = new Server({ name: 'proxy-sse-fixture', version: '1' }, { capabilities: { tools: {},
      ...(options.taskMode === undefined ? {} : { tasks: { requests: { tools: { call: {} } }, cancel: {} } }),
    }, instructions: 'Legacy SSE instructions.', ...(options.taskMode === undefined ? {} : {
      taskStore: store, taskMessageQueue: new InMemoryTaskMessageQueue(),
    }) })
    if (options.taskMode === 'batched' || options.taskMode === 'foreign-task') batchedCallbacks.set(server, (taskId) => {
      const work = server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'Batched task sampling' } }],
        maxTokens: 16, _meta: { [RELATED_TASK_META_KEY]: { taskId: options.taskMode === 'foreign-task' ? `${taskId}-foreign` : taskId } },
      }, { signal: callbackStop.signal }).then(async (sample) => {
        await store.storeTaskResult(taskId, 'completed', { content: [], structuredContent: { sampled: sample } })
      }, async () => {
        const current = await store.getTask(taskId)
        if (current?.status === 'working') await store.updateTaskStatus(taskId, 'failed')
      })
      taskWork.add(work)
      void work.then(() => { taskWork.delete(work) }, () => { taskWork.delete(work) })
    })
    if (options.taskMode !== undefined) server.setRequestHandler(GetTaskRequestSchema, async (request) => {
      taskPolled.resolve(undefined)
      const task = await store.getTask(request.params.taskId)
      if (task === null) throw new Error('Fixture task missing')
      return task
    })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.taskMode === undefined
      ? ['ping', 'roots', 'sample', 'ask'].map(name => ({ name, inputSchema: { type: 'object' as const } }))
      : [{ name: 'task', inputSchema: { type: 'object' as const }, execution: { taskSupport: 'required' as const },
        ...(options.taskMode === 'bad-output' ? { outputSchema: { type: 'object' as const,
          properties: { answer: { type: 'string' } }, required: ['answer'],
        } } : {}),
      }],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name === 'task') {
        if (request.params.task === undefined || extra.taskStore === undefined) throw new Error('Task execution required')
        ++taskCalls
        const task = await extra.taskStore.createTask({ ttl: 30000, pollInterval: 10 })
        taskCreated.resolve(undefined)
        if (options.taskMode === 'sample') {
          await store.updateTaskStatus(task.taskId, 'input_required')
          const work = server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'Task sampling' } }], maxTokens: 16 }, {
            relatedTask: { taskId: task.taskId }, signal: callbackStop.signal,
          }).then(async (sample) => {
            await store.storeTaskResult(task.taskId, 'completed', { content: [], structuredContent: { sampled: sample, taskCalls } })
          }, async () => {
            const current = await store.getTask(task.taskId)
            if (current?.status === 'working' || current?.status === 'input_required') await store.updateTaskStatus(task.taskId, 'failed')
          })
          taskWork.add(work)
          void work.then(() => { taskWork.delete(work) }, () => { taskWork.delete(work) })
        } else if (options.taskMode !== 'wait' && options.taskMode !== 'batched' && options.taskMode !== 'foreign-task') {
          await store.storeTaskResult(task.taskId, 'completed', options.taskMode === 'error'
            ? { content: [{ type: 'text', text: 'Task tool refusal' }], isError: true }
            : { content: [], structuredContent: options.taskMode === 'bad-output' ? { answer: 42 } : { taskCalls } })
        }
        return { task }
      }
      if (request.params.name === 'roots') {
        const result = await server.listRoots(undefined, { relatedRequestId: extra.requestId })
        return { content: [], structuredContent: { roots: result.roots } }
      }
      if (request.params.name === 'sample') {
        try {
          const result = await server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }], maxTokens: 16 }, {
            relatedRequestId: extra.requestId, signal: callbackStop.signal,
          })
          return { content: [], structuredContent: { sampled: result } }
        } catch (error) {
          if (options.holdAfterCallback) {
            await server.ping()
            callbackStopped.resolve(undefined)
            await release.promise
          }
          return { content: [{ type: 'text' as const, text: String(error) }], isError: true }
        }
      }
      if (request.params.name === 'ask') {
        const result = await server.elicitInput({ message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }, { relatedRequestId: extra.requestId })
        return { content: [], structuredContent: { answer: result } }
      }
      return { content: [{ type: 'text', text: 'pong' }], _meta: { local: true } }
    })
    return server
  }
  async function route(request: IncomingMessage, response: ServerResponse) {
    observed.push(request.headers.authorization)
    if (!legacy) {
      if (!options.legacyProtocol) { await modern(request as NodeIncomingMessageLike, response); return }
      const id = request.headers['mcp-session-id']
      const existing = typeof id === 'string' ? httpSessions.get(id) : undefined
      if (existing !== undefined) { await existing.handleRequest(request, response); return }
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      const owner = legacyServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => { httpSessions.set(sessionId, transport) },
      })
      httpServers.add(owner)
      // SDK 1 transport getters admit undefined before a connection starts.
      await owner.connect(transport as Transport)
      await transport.handleRequest(request, response)
      return
    }
    if (request.method === 'GET') {
      response.once('close', () => { disconnected.resolve(undefined) })
      const transport = new SSEServerTransport('/messages', response)
      const server = legacyServer()
      if (options.taskMode === 'batched' || options.taskMode === 'foreign-task') {
        const send = transport.send.bind(transport)
        transport.send = async (message) => {
          const parsed = 'result' in message ? CreateTaskResultSchema.safeParse(message.result) : undefined
          if (parsed?.success) {
            response.cork()
            try { await send(message); batchedCallbacks.get(server)?.(parsed.data.task.taskId) }
            finally { response.uncork() }
          } else await send(message)
        }
      }
      sessions.set(transport.sessionId, { transport, server })
      await server.connect(transport)
    } else {
      const id = new URL(request.url ?? '/', 'http://localhost').searchParams.get('sessionId')
      const session = id === null ? undefined : sessions.get(id)
      if (session === undefined) { response.writeHead(404).end(); return }
      await session.transport.handlePostMessage(request, response)
    }
  }
  const server = createServer((request, response) => {
    void route(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind')
  return {
    url: `http://127.0.0.1:${address.port}/${legacy ? 'sse' : 'mcp'}`,
    observed,
    discoveryStarted: () => discoveryStarted,
    entered: entered.promise,
    disconnected: disconnected.promise,
    callbackStopped: callbackStopped.promise,
    taskCreated: taskCreated.promise,
    taskCancelled: taskCancelled.promise,
    taskPolled: taskPolled.promise,
    taskCalls: () => taskCalls,
    cancelCallback: () => { callbackStop.abort() },
    release: () => { release.resolve(undefined) },
    close: async () => {
      callbackStop.abort()
      release.resolve(undefined)
      await Promise.all([...sessions.values()].map(session => session.server.close()))
      await Promise.all([...httpServers].map(owner => owner.close()))
      await handler.close()
      await Promise.allSettled(taskWork)
      for (const store of taskStores) store.cleanup()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    },
  }
}
