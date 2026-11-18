import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { connect as connectTcp } from 'node:net'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { decodeFrame } from '@jshow/app-mcp-proxy/protocol'
import type WebSocket from 'ws'
import { expect, it, onTestFinished } from 'vitest'
import Host, { type ProxyCatalog } from '../../src/host/index.ts'
import { openHost as boot, HOST_FIXTURE_NAME } from './helpers/composition.ts'

async function publish(socket: WebSocket, value: ProxyCatalog) {
  const received = once(socket, 'message')
  socket.send(JSON.stringify(value))
  return decodeFrame(String((await received)[0]), 65536)
}

const catalog = (revision = 'r1'): ProxyCatalog => ({ v: 1, kind: 'catalog', revision: revision as ProxyCatalog['revision'],
  services: [{ service: 'files', incarnation: 'same-client' as NonNullable<ProxyCatalog['services'][number]['incarnation']>,
    instructions: 'Local files', serverInfo: { name: 'files', version: '1' } }],
  tools: [{ service: 'files', name: 'read', inputSchema: { type: 'object' } }],
})

it('admits the configured credential and signed identity, publishes tools and invokes the pinned generation', async () => {
  const fixture = await boot()
  const peer = await fixture.local()
  const acknowledged = once(peer.socket, 'message')
  peer.socket.send(JSON.stringify(catalog()))
  expect(decodeFrame(String((await acknowledged)[0]), 65536)).toMatchObject({ kind: 'catalog-accepted', revision: 'r1' })
  const selected = fixture.ctx.mcpProxy.select(peer.identity.endpointId)
  expect(selected?.catalog.services[0]?.instructions).toBe('Local files')
  if (selected === undefined) throw new Error('Expected registered catalog')
  expect(await fixture.ctx.mcpProxy.invoke(selected, { revision: 'r1', service: 'files', name: 'read', args: {} })).toMatchObject({ _meta: { local: true } })
  selected.catalog.tools.length = 0
  expect(fixture.ctx.mcpProxy.select(peer.identity.endpointId)?.catalog.tools).toHaveLength(1)
})

it.each(['credential', 'host'])('rejects an invalid %s before issuing a signature challenge', async (kind) => {
  const fixture = await boot()
  const socket = kind === 'credential' ? fixture.connect('wrong') : fixture.connect(undefined, 'attacker.example')
  const response = await new Promise<number>((resolve) => {
    socket.once('unexpected-response', (_request, incoming) => { incoming.resume(); socket.terminate(); resolve(incoming.statusCode ?? 0) })
  })
  expect(response).toBe(401)
})

it('re-resolves a rotated deployment credential for the next upgrade', async () => {
  const fixture = await boot()
  await fixture.ctx.credentials.set(credentialRef(fixture.ref), randomUUID())
  const socket = fixture.connect()
  const status = await new Promise<number>((resolve) => {
    socket.once('unexpected-response', (_request, incoming) => { incoming.resume(); socket.terminate(); resolve(incoming.statusCode ?? 0) })
  })
  expect(status).toBe(401)
})

it('refuses a tool absent from the current catalog and conflicting revision contents', async () => {
  const fixture = await boot()
  const peer = await fixture.local()
  await publish(peer.socket, catalog())
  const selected = fixture.ctx.mcpProxy.select(peer.identity.endpointId)
  if (selected === undefined) throw new Error('Expected registered catalog')
  await expect(fixture.ctx.mcpProxy.invoke(selected, { revision: 'r1', service: 'files', name: 'delete', args: {} })).rejects.toMatchObject({ code: 'unavailable' })
  expect(await publish(peer.socket, { ...catalog(), tools: [] })).toMatchObject({ kind: 'catalog-rejected', code: 'conflict' })
  expect(fixture.ctx.mcpProxy.select(peer.identity.endpointId)?.catalog.tools).toHaveLength(1)
  expect(await publish(peer.socket, catalog('r2'))).toMatchObject({ kind: 'catalog-accepted' })
  expect(await fixture.ctx.mcpProxy.invoke(selected, { revision: 'r1', service: 'files', name: 'read', args: {} }))
    .toMatchObject({ content: [{ type: 'text', text: 'read' }] })
  await publish(peer.socket, { ...catalog('r3'), tools: [{ service: 'files', name: 'read', inputSchema: { type: 'object', required: ['changed'] } }] })
  await expect(fixture.ctx.mcpProxy.invoke(selected, { revision: 'r1', service: 'files', name: 'read', args: {} }))
    .rejects.toMatchObject({ code: 'unavailable' })
})

it('rejects a retired catalog without redirecting it to the current alias', async () => {
  const fixture = await boot(4, [], { name: 'bounded-catalog-host', module: Host,
    config: (publicOrigin, credentialRef) => ({ publicOrigin, credentialRef, maxCatalogRevisions: 1 }) })
  const peer = await fixture.local()
  await publish(peer.socket, catalog())
  const selected = fixture.ctx.mcpProxy.select(peer.identity.endpointId)
  if (selected === undefined) throw new Error('Expected catalog')
  expect(await publish(peer.socket, catalog('r2'))).toMatchObject({ kind: 'catalog-accepted' })
  await expect(fixture.ctx.mcpProxy.invoke(selected, { revision: 'r1', service: 'files', name: 'read', args: {} }))
    .rejects.toMatchObject({ code: 'unavailable' })
  expect(fixture.ctx.mcpProxy.select(peer.identity.endpointId)?.catalog.revision).toBe('r2')
  expect(await publish(peer.socket, catalog())).toMatchObject({ kind: 'catalog-rejected', code: 'unavailable' })
  expect(await publish(peer.socket, { ...catalog(), tools: [] })).toMatchObject({ kind: 'catalog-rejected', code: 'conflict' })
})

it('does not route an old selection into a reconnected generation', async () => {
  const fixture = await boot()
  const peer = await fixture.local()
  await publish(peer.socket, catalog())
  const selected = fixture.ctx.mcpProxy.select(peer.identity.endpointId)
  if (selected === undefined) throw new Error('Expected registered catalog')
  peer.socket.terminate()
  await expect.poll(() => fixture.ctx.mcpProxy.select(peer.identity.endpointId)).toBeUndefined()
  const replacement = await fixture.local(peer.identity)
  await publish(replacement.socket, catalog())
  expect(fixture.ctx.mcpProxy.select(peer.identity.endpointId)?.generation).not.toBe(selected.generation)
  await expect(fixture.ctx.mcpProxy.invoke(selected, { revision: 'r1', service: 'files', name: 'read', args: {} })).rejects.toMatchObject({ code: 'unavailable' })
})

it('counts connections still awaiting proof against the deployment capacity', async () => {
  const fixture = await boot(1)
  const pending = fixture.connect()
  await once(pending, 'open')
  const refused = fixture.connect()
  const status = await new Promise<number>((resolve) => {
    refused.once('unexpected-response', (_request, response) => { response.resume(); refused.terminate(); resolve(response.statusCode ?? 0) })
  })
  expect(status).toBe(503)
})

it('unmounts the upgrade route and closes existing connections on plugin disposal', async () => {
  const fixture = await boot()
  const peer = await fixture.local()
  const fiber = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === HOST_FIXTURE_NAME)?.fiber
  if (fiber === undefined) throw new Error('Expected Loader-owned proxy fiber')
  const closed = once(peer.socket, 'close')
  await fiber.dispose()
  await closed
  expect(fixture.ctx.get('mcpProxy')).toBeUndefined()
  const refused = fixture.connect()
  const failure = await new Promise<Error>((resolve) => { refused.once('error', resolve) })
  expect(failure.message).toContain('socket hang up')
})

it.each([401, 503] as const)('fully closes a refused %s upgrade even when the client keeps its write half open', async (status) => {
  const fixture = await boot(1)
  if (status === 503) {
    const pending = fixture.connect()
    await once(pending, 'open')
  }
  const socket = connectTcp({ host: '127.0.0.1', port: fixture.ctx.webServer.port, allowHalfOpen: true })
  onTestFinished(() => { socket.destroy() })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  socket.on('error', () => { /* A reset after the refusal also confirms complete server-side closure. */ })
  let probe: ReturnType<typeof setInterval> | undefined
  socket.once('end', () => { probe = setInterval(() => { socket.write('probe after refusal') }, 10) })
  onTestFinished(() => { clearInterval(probe) })
  await once(socket, 'connect')
  const received = once(socket, 'data')
  socket.write([
    'GET /mcp-proxy/connect HTTP/1.1', `Host: ${new URL(fixture.origin).host}`, 'Authorization: Bearer wrong',
    'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', '',
  ].join('\r\n'))
  expect(String((await received)[0])).toContain(`HTTP/1.1 ${status}`)
  await closed
  clearInterval(probe)
})
