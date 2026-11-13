import { access, appendFile, readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { inputRequired, McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

if (process.env.MCP_FIXTURE_START_MARKER) await appendFile(process.env.MCP_FIXTURE_START_MARKER, JSON.stringify({ pid: process.pid }) + '\n')

serveStdio(() => {
  const server = new McpServer({ name: 'proxy-files-fixture', version: '1' }, { instructions: 'Append files in the configured local working directory.' })
  server.registerTool('append', { description: 'Append local text', inputSchema: z.object({ path: z.string(), text: z.string() }) }, async ({ path, text }) => {
    await appendFile(path, text)
    return { content: [{ type: 'text', text: 'written' }], structuredContent: { path }, _meta: { local: true } }
  })
  server.registerTool('pid', { inputSchema: z.object({}) }, async () => ({ content: [], structuredContent: { pid: process.pid } }))
  server.registerTool('read', { description: 'Read a local UTF-8 text file', inputSchema: z.object({ path: z.string() }) }, async ({ path }) => ({
    content: [{ type: 'text', text: await readFile(path, 'utf8') }], structuredContent: { path }, _meta: { local: true },
  }))
  server.registerTool('sample', { inputSchema: z.object({}) }, async (_args, context) => {
    if (context.mcpReq.requestState() !== undefined) {
      return { content: [], structuredContent: z.record(z.string(), z.json()).parse(context.mcpReq.inputResponses) }
    }
    return inputRequired({ requestState: 'stdio-sampling', inputRequests: {
      sample: { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'Say hello' } }], maxTokens: 16 } },
    } })
  })
  server.registerTool('ask', { inputSchema: z.object({}) }, async (_args, context) => {
    if (context.mcpReq.requestState() !== undefined) {
      return { content: [], structuredContent: z.record(z.string(), z.json()).parse(context.mcpReq.inputResponses) }
    }
    return inputRequired({ requestState: 'stdio-elicitation', inputRequests: {
      answer: { method: 'elicitation/create', params: { mode: 'form', message: 'Your name?', requestedSchema: {
        type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'],
      } } },
    } })
  })
  server.registerTool('append-wait', { inputSchema: z.object({ path: z.string(), text: z.string(), release: z.string() }) },
    async ({ path, text, release }) => {
      await appendFile(path, text)
      for (;;) {
        try { await access(release); break }
        catch (_error) { await setTimeout(10) }
      }
      return { content: [] }
    })
  server.registerTool('has-env', { inputSchema: z.object({ name: z.string() }) }, async ({ name }) => ({
    content: [], structuredContent: { present: Object.hasOwn(process.env, name) },
  }))
  return server
})
