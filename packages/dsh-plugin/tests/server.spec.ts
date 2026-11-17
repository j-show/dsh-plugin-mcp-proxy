import Agents from '@deepseek-ai/dsh-agent'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Agent from '@jshow/dsh-plugin-mcp-proxy/agent'
import * as Browser from '@jshow/dsh-plugin-mcp-proxy/browser'
import * as Ui from '@jshow/dsh-plugin-mcp-proxy/ui'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { openHost } from '../modules/host/tests/helpers/composition.ts'
import * as Server from '../src/index.ts'

it('rejects mounting without a profile Loader entry before creating adapter children', async () => {
  const ctx = new Context()
  try {
    const parsed = await Server.Config['~standard'].validate({
      host: { publicOrigin: 'https://agent.example', credentialRef: 'MCP_TOKEN' },
    })
    if (parsed.issues !== undefined) throw new Error('Expected valid deployment configuration')
    await expect(Server.apply(ctx, parsed.value as Server.Config)).rejects.toThrow('MCP proxy server requires a profile Loader entry')
    expect(ctx.get('mcpProxy')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

async function mountServer(ui?: unknown, expectedActivationError?: RegExp) {
  const fixture = await openHost(4, [
    { name: '@deepseek-ai/dsh-llm', module: Llm, config: () => ({}) },
    { name: '@deepseek-ai/dsh-session', module: Sessions, config: () => ({}) },
    { name: '@deepseek-ai/dsh-session-projection', module: Projections, config: () => ({}) },
    { name: '@deepseek-ai/dsh-system-prompt', module: Prompt, config: () => ({}) },
    { name: '@deepseek-ai/dsh-tools', module: Tools, config: () => ({}) },
    { name: '@deepseek-ai/dsh-agent', module: Agents, config: () => ({}) },
    { name: '@deepseek-ai/dsh-client-connection', module: Connection, config: origin => ({ trustedHosts: [new URL(origin).host] }) },
  ], { name: '@jshow/dsh-plugin-mcp-proxy', module: Server,
    expectedActivationError,
    config: (origin, ref) => ({ host: { publicOrigin: origin, credentialRef: ref }, ...(ui === undefined ? {} : { ui }) }),
    modules: [
      ['@jshow/dsh-plugin-mcp-proxy/agent', Agent], ['@jshow/dsh-plugin-mcp-proxy/browser', Browser],
      ['@jshow/dsh-plugin-mcp-proxy/ui', Ui],
    ],
  })
  return fixture
}

it('mounts and disposes the connector and browser routes through one Loader entry', async () => {
  const fixture = await mountServer()
  expect(fixture.ctx.get('mcpProxy')).toBeDefined()
  const adapterEntries = [...fixture.ctx.loader.entries()].filter(entry => [
    '@jshow/dsh-plugin-mcp-proxy/host', '@jshow/dsh-plugin-mcp-proxy/agent', '@jshow/dsh-plugin-mcp-proxy/browser',
  ].includes(entry.options.name))
  expect(adapterEntries).toHaveLength(3)
  expect([...fixture.ctx.loader.entries()].some(entry => entry.options.name === '@jshow/dsh-plugin-mcp-proxy/ui')).toBe(true)
  const peer = await fixture.local()
  expect(peer.identity.endpointId).toBeTruthy()
  const handler = fixture.ctx.connection.createSharedFetchHandler('/api')
  const uiConfig = await handler.fetch(new Request(fixture.origin + '/api/mcp-proxy/ui-config'))
  expect(uiConfig.status).toBe(200)
  expect(await uiConfig.json()).toMatchObject({ pollIntervalMs: 500, maxResponseBytes: 65536 })
  expect((await handler.fetch(new Request(fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', body: '{}' }))).status).toBe(401)
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === '@jshow/dsh-plugin-mcp-proxy')?.fiber
  if (fiber === undefined) throw new Error('Expected unified server plugin')
  await fiber.dispose()
  expect(fixture.ctx.get('mcpProxy')).toBeUndefined()
  expect((await handler.fetch(new Request(fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', body: '{}' }))).status).toBe(404)
})

it('rolls back the host and API when later UI configuration fails activation', async () => {
  const fixture = await mountServer({ maxResponseBytes: 0 }, /maxResponseBytes/)
  expect(fixture.ctx.get('mcpProxy') === undefined).toBe(true)
  expect([...fixture.ctx.loader.entries()].some(entry => entry.options.name === '@jshow/dsh-plugin-mcp-proxy/browser')).toBe(false)
  const handler = fixture.ctx.connection.createSharedFetchHandler('/api')
  expect((await handler.fetch(new Request(fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', body: '{}' }))).status).toBe(404)
})
