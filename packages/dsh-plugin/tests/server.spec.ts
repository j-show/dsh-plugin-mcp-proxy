import Agents from '@deepseek-ai/dsh-agent'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Agent from '../src/agent/index.ts'
import * as Browser from '../src/browser/index.ts'
import * as Ui from '../src/ui/index.ts'
import Host from '../src/host/index.ts'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { openHost } from './host/helpers/composition.ts'
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
  const order:string[]=[]
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
    observe:ctx=>{ctx.on('internal/plugin',fiber=>{
      if(fiber.uid===null)return // The same event also reports disposal; count creation only.
      const callback=fiber.runtime?.callback
      const component=callback===Host?'host':callback===Agent.apply?'agent':callback===Browser.apply?'browser':callback===Ui.apply?'ui':undefined
      if(component)order.push(component)
    })},
    config: (origin, ref) => ({ host: { publicOrigin: origin, credentialRef: ref }, ...(ui === undefined ? {} : { ui }) }),
  })
  return {...fixture,order}
}

it('mounts and disposes the connector and browser routes through one Loader entry', async () => {
  const fixture = await mountServer()
  expect(fixture.order).toEqual(['host','agent','browser','ui'])
  expect(fixture.ctx.get('mcpProxy')).toBeDefined()
  const adapterEntries = [...fixture.ctx.loader.entries()].filter(entry => [
    '../src/host/index.ts', '../src/agent/index.ts', '../src/browser/index.ts',
  ].includes(entry.options.name))
  expect(adapterEntries).toHaveLength(0)
  expect([...fixture.ctx.loader.entries()].some(entry => entry.options.name === '../src/ui/index.ts')).toBe(false)
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
  for(const component of [Host,Agent.apply,Browser.apply,Ui.apply])expect(fixture.ctx.registry.has(component)).toBe(false)
  expect(fixture.ctx.get('mcpProxy')).toBeUndefined()
  expect((await handler.fetch(new Request(fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', body: '{}' }))).status).toBe(404)
})

it('rolls back the host and API when later UI configuration fails activation', async () => {
  const fixture = await mountServer({ maxResponseBytes: 0 }, /maxResponseBytes/)
  for(const component of [Host,Agent.apply,Browser.apply,Ui.apply])expect(fixture.ctx.registry.has(component)).toBe(false)
  expect(fixture.ctx.get('mcpProxy') === undefined).toBe(true)
  expect([...fixture.ctx.loader.entries()].some(entry => entry.options.name === '../src/browser/index.ts')).toBe(false)
  const handler = fixture.ctx.connection.createSharedFetchHandler('/api')
  expect((await handler.fetch(new Request(fixture.origin + '/api/mcp-proxy/begin', { method: 'POST', body: '{}' }))).status).toBe(404)
})

it('restarts the parent with joined component cleanup and the same activation order',async()=>{
  const fixture=await mountServer()
  const fiber=[...fixture.ctx.loader.entries()].find(entry=>entry.options.name==='@jshow/dsh-plugin-mcp-proxy')?.fiber
  if(!fiber)throw new Error('Expected server scope')
  await fiber.restart()
  expect(fixture.order).toEqual(['host','agent','browser','ui','host','agent','browser','ui'])
  expect(fixture.ctx.get('mcpProxy')).toBeDefined()
  const handler=fixture.ctx.connection.createSharedFetchHandler('/api')
  expect((await handler.fetch(new Request(fixture.origin+'/api/mcp-proxy/ui-config'))).status).toBe(200)
  await fiber.dispose()
  for(const component of [Host,Agent.apply,Browser.apply,Ui.apply])expect(fixture.ctx.registry.has(component)).toBe(false)
})
