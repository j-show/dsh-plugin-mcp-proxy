import { appendFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'

const store = new InMemoryTaskStore()
const server = new Server({ name: 'legacy-task-stdio', version: '1' }, { capabilities: { tools: {},
  tasks: { requests: { tools: { call: {} } }, cancel: {} },
}, taskStore: store, taskMessageQueue: new InMemoryTaskMessageQueue() })
server.onclose = () => { store.cleanup() }
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'write-task',
  inputSchema: { type: 'object' }, execution: { taskSupport: 'required' },
}] }))
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.task === undefined || extra.taskStore === undefined) throw new Error('Task execution required')
  const task = await extra.taskStore.createTask({ ttl: 30000, pollInterval: 10 })
  await appendFile('task-effect.txt', 'once')
  await extra.taskStore.storeTaskResult(task.taskId, 'completed', { content: [{ type: 'text', text: 'written' }] })
  return { task }
})
await server.connect(new StdioServerTransport())
