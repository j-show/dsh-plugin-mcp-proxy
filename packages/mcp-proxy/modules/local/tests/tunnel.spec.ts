import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { expect, it, onTestFinished } from 'vitest'
import { acceptProxyIdentity, proveProxyIdentity, ProxyChannel, ProxyIdentity } from '@j-show/mcp-proxy-protocol'
import { attachLocalProxy, LocalMcpPool, resolveLocalServices } from '../src/index.ts'

it('routes a signed remote connection to an actual local MCP file operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-proxy-tunnel-'))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const owned: { client?: WebSocket; pool?: LocalMcpPool; local?: ProxyChannel; host?: ProxyChannel } = {}
  onTestFinished(async () => {
    await Promise.all([owned.host?.close(), owned.local?.close()])
    await owned.pool?.close()
    owned.client?.terminate()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    await rm(directory, { recursive: true, force: true })
  })
  await once(server, 'listening')
  const accepted = once(server, 'connection')
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`)
  owned.client = client
  await once(client, 'open')
  const [remote] = await accepted as [WebSocket]
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'files', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/files.mjs', import.meta.url))],
  }], directory), { maxServices: 4, maxFrameBytes: 65536, maxDiscoveryPages: 8, maxClientRequests: 8,
    maxClientRequestRecords: 64, startupTimeoutMs: 10000, callTimeoutMs: 10000, taskCancelTimeoutMs: 1000 })
  owned.pool = pool
  const catalog = await pool.catalog()
  const limits = { maxFrameBytes: 65536, maxInvocations: 64, maxPending: 4 }
  const identity = ProxyIdentity.generate()
  const hostProof = acceptProxyIdentity(remote, 'https://agent.example', { maxFrameBytes: 65536, timeoutMs: 10000 }, (peer) => {
    owned.host = new ProxyChannel(remote, { ...limits, generation: peer.generation })
  })
  const localProof = proveProxyIdentity(client, identity, 'https://agent.example', { maxFrameBytes: 65536, timeoutMs: 10000 }, (peer) => {
    owned.local = attachLocalProxy(client, peer, pool, catalog, limits)
  })
  await Promise.all([hostProof, localProof])
  const host = owned.host
  if (host === undefined) throw new Error('Host channel not installed')
  const result = await host.invoke({ revision: catalog.revision, service: 'files', name: 'append',
    args: { path: 'deliverable.txt', text: 'written through the proxy' },
  }, 10000)
  expect(result).toMatchObject({ structuredContent: { path: 'deliverable.txt' }, _meta: { local: true } })
  expect(await readFile(join(directory, 'deliverable.txt'), 'utf8')).toBe('written through the proxy')
  await pool.remove('files')
  await pool.add(resolveLocalServices([{ service: 'files', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/files.mjs', import.meta.url))],
  }], directory)[0]!, new AbortController().signal)
  await expect(host.invoke({ revision: catalog.revision, service: 'files', name: 'append',
    args: { path: 'deliverable.txt', text: 'wrong replacement' },
  }, 10000)).rejects.toThrow()
  expect(await readFile(join(directory, 'deliverable.txt'), 'utf8')).toBe('written through the proxy')
})
