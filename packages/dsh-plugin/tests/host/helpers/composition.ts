import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { decodeFrame, proveProxyIdentity, ProxyChannel, ProxyIdentity, type ProxyFrame, type ChannelOptions } from '@jshow/app-mcp-proxy/protocol'
import WebSocket from 'ws'
import { expect, onTestFinished } from 'vitest'
import Host from '../../../src/host/index.ts'
export const HOST_FIXTURE_NAME='test:mcp-proxy-host'

interface TestPlugin { name: string; module: unknown; config: (origin: string) => Record<string, unknown> }
interface TestHostEntry {
  name: string
  module: unknown
  config: (origin: string, credentialRef: string) => Record<string, unknown>
  modules?: readonly (readonly [string, unknown])[]
  expectedActivationError?: RegExp
  observe?: (ctx:Context)=>void
}

export async function openHost(maxConnections = 4, plugins: readonly TestPlugin[] = [], hostEntry?: TestHostEntry, callTimeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-proxy-host-'))
  const ctx = new Context()
  const sockets = new Set<WebSocket>()
  onTestFinished(async () => {
    for (const socket of sockets) socket.terminate()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const origin = `https://agent-${randomUUID()}.example`
  const ref = `MCP_${randomUUID().replaceAll('-', '_')}`
  const token = randomUUID()
  const credentials = join(root, '.credentials.yaml')
  await writeFile(credentials, `version: 1\nrefs:\n  ${ref}: ${token}\n`, { mode: 0o600 })
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    "- name: '@deepseek-ai/dsh-host-webserver'", "  config: { host: '127.0.0.1', port: 0 }",
    "- name: '@deepseek-ai/dsh-credentials-local'", `  config: { path: ${JSON.stringify(credentials)}, watch: false }`,
    ...(hostEntry === undefined ? [
      `- name: '${HOST_FIXTURE_NAME}'`, '  config:', `    publicOrigin: ${origin}`, `    credentialRef: ${ref}`,
      '    upgradePath: /mcp-proxy/connect', `    maxConnections: ${maxConnections}`, '    maxFrameBytes: 65536',
      '    handshakeTimeoutMs: 1000', `    callTimeoutMs: ${callTimeoutMs}`, '    maxInvocations: 64', '    maxPending: 4',
    ] : ['- ' + JSON.stringify({ name: hostEntry.name, config: hostEntry.config(origin, ref) })]),
    ...plugins.map(plugin => '- ' + JSON.stringify({ name: plugin.name, config: plugin.config(origin) })), '',
  ].join('\n'))
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer], ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    [HOST_FIXTURE_NAME, Host], ...plugins.map(plugin => [plugin.name, plugin.module] as const),
    ...(hostEntry === undefined ? [] : [[hostEntry.name, hostEntry.module] as const]),
    ...(hostEntry?.modules ?? []),
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (!modules.has(name)) throw new Error('Unexpected test composition import')
    return modules.get(name)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  hostEntry?.observe?.(ctx)
  const startup = (async () => {
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
  })()
  if (hostEntry?.expectedActivationError) await expect(startup).rejects.toThrow(hostEntry.expectedActivationError)
  else await startup
  function connect(secret: string = token, host = new URL(origin).host) {
    const socket = new WebSocket(`ws://127.0.0.1:${ctx.webServer.port}/mcp-proxy/connect`, {
      headers: { Host: host, Authorization: `Bearer ${secret}` },
    })
    sockets.add(socket)
    socket.on('error', () => { /* Expected upgrade refusals are asserted through their HTTP response. */ })
    return socket
  }
  async function local(identity = ProxyIdentity.generate(), onInvoke?: ChannelOptions['onInvoke']) {
    const socket = connect()
    const frames: ProxyFrame[] = []
    socket.on('message', (data) => { frames.push(decodeFrame(data.toString(), 65536)) })
    let channel: ProxyChannel | undefined
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('open', () => {
        void proveProxyIdentity(socket, identity, origin, { maxFrameBytes: 65536, timeoutMs: 1000 }, (peer) => {
          channel = new ProxyChannel(socket, { generation: peer.generation, maxFrameBytes: 65536, maxInvocations: 64, maxPending: 4,
            onInvoke: onInvoke ?? (async frame => ({ content: [{ type: 'text', text: frame.name }], _meta: { local: true } })),
          })
        }).then(() => { socket.off('error', reject); resolve() }, reject)
      })
    })
    onTestFinished(async () => { await channel?.close() })
    if (channel === undefined) throw new Error('Expected attached local channel')
    return { socket, frames, identity, channel }
  }
  return { ctx, connect, local, ref, origin }
}

