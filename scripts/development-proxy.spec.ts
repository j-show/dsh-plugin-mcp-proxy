import { expect, it, onTestFinished } from 'vitest'
import { createServer } from 'node:http'
import { request } from 'node:https'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { X509Certificate } from 'node:crypto'
import { generateDevelopmentTls } from './development.ts'
import { createDevelopmentProxy } from './development-proxy.ts'

it.skipIf(process.platform !== 'win32')('creates unique trusted localhost TLS and preserves authenticated route headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-development-tls-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  await generateDevelopmentTls(directory)
  const ca = await readFile(join(directory, 'ca.pem'))
  expect(new X509Certificate(ca).ca).toBe(true)
  const upstream = createServer((incoming, outgoing) => {
    outgoing.end(JSON.stringify({ url: incoming.url, host: incoming.headers.host, origin: incoming.headers.origin, cookie: incoming.headers.cookie }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No upstream port')
  const observed: Array<{ path: string; status: number }> = []
  const proxy = createDevelopmentProxy(await readFile(join(directory, 'server.pfx')), address.port, entry => observed.push(entry))
  onTestFinished(async () => { await proxy.close(); await new Promise<void>(resolve => { upstream.close(() => resolve()) }) })
  proxy.server.listen(0, '127.0.0.1'); await once(proxy.server, 'listening')
  const target = proxy.server.address()
  if (!target || typeof target === 'string') throw new Error('No TLS port')
  const value = await new Promise<string>((resolve, reject) => {
    const call = request({ hostname: '127.0.0.1', port: target.port, path: '/mcp-proxy/pair?private=ticket', method: 'POST', ca,
      headers: { host: 'localhost:3443', origin: 'https://localhost:3443', cookie: 'test-only' } }, response => {
      let body = ''; response.on('data', chunk => { body += String(chunk) }); response.on('end', () => resolve(body))
    })
    call.on('error', reject); call.end()
  })
  expect(JSON.parse(value)).toEqual({ url: '/mcp-proxy/pair?private=ticket', host: 'localhost:3443', origin: 'https://localhost:3443', cookie: 'test-only' })
  expect(observed).toEqual([{ path: '/mcp-proxy/pair', status: 200 }])
})
