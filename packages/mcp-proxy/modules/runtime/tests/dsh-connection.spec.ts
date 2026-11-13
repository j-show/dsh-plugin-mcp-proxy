import { Context } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalMcpPool, LocalInvocationRoutes, parseManagedMcpSettings } from '@j-show/mcp-proxy-local'
import { acceptProxyIdentity, decodeFrame, ProxyIdentity, type AssociationRequestId, type CatalogRevision } from '@j-show/mcp-proxy-protocol'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { expect, it, onTestFinished } from 'vitest'
import { openDshConnection } from '../src/dsh-connection.ts'

it('uses device identity over verified TLS, acknowledges catalogs and keeps retired revisions unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-dsh-socket-'))
  const ctx = new Context()
  const caFile = fileURLToPath(new URL('./fixtures/localhost-cert.pem', import.meta.url))
  const server = createServer({ cert: await readFile(caFile), key: await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)) })
  const sockets = new WebSocketServer({ noServer: true })
  const pool = await LocalMcpPool.open([], { maxServices: 4, maxFrameBytes: 65536, maxDiscoveryPages: 8,
    maxClientRequests: 8, maxClientRequestRecords: 32, startupTimeoutMs: 2000, callTimeoutMs: 2000, taskCancelTimeoutMs: 1000 })
  onTestFinished(async () => {
    await pool.close(); await ctx.fiber.dispose()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>(resolve => { sockets.close(() => { resolve() }) })
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Credentials, { path: join(root, 'identity.yaml'), watch: false })
  const identity = ProxyIdentity.generate()
  await ctx.credentials.set(credentialRef('DEVICE'), identity.exportPrivateKey())
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TLS listener')
  const origin = `https://127.0.0.1:${address.port}`
  const received: string[] = []
  server.on('upgrade', (request, socket, head) => {
    expect(request.headers.authorization).toBe(`Device ${identity.endpointId}`)
    sockets.handleUpgrade(request, socket, head, socket => {
      void acceptProxyIdentity(socket, origin, { timeoutMs: 2000, maxFrameBytes: 65536 }, () => {
        socket.on('message', data => {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
          const frame = decodeFrame(bytes.toString(), 65536)
          if (frame.kind === 'catalog') socket.send(JSON.stringify({ v: 1, kind: 'catalog-accepted', revision: frame.revision }))
          if (frame.kind === 'association') received.push(frame.requestId)
        })
      }).catch(() => { socket.terminate() })
    })
  })
  const [entry] = parseManagedMcpSettings({ version: 2, directory: root, identityFile: 'identity.yaml', services: [],
    servers: [{ id: 'server', origin, enabled: true, mode: 'device', identityRef: 'DEVICE', caFile }] }, root).servers
  const catalog = await pool.catalog()
  const options = { maxFrameBytes: 65536, maxInvocations: 32, maxPending: 4, upgradePath: '/mcp-proxy/connect',
    startupTimeoutMs: 2000, callTimeoutMs: 2000, maxCatalogRevisions: 1, maxCatalogHistory: 8 }
  const channel = await openDshConnection(entry!, { pool, routes: new LocalInvocationRoutes(32), catalog,
    signal: new AbortController().signal }, ctx.credentials, options)
  onTestFinished(() => channel.close())
  await channel.associate('a'.repeat(43) as AssociationRequestId)
  await expect.poll(() => received).toEqual(['a'.repeat(43)])
  await channel.publish({ ...catalog, revision: 'replacement' as CatalogRevision })
  await expect(channel.publish(catalog)).rejects.toThrow()
})
