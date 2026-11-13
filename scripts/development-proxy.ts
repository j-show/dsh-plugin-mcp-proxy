/** Loopback-only TLS termination for the genuine DSH HTTP and WebSocket handlers. */
import { createServer, type Server } from 'node:https'
import { request as requestHttp } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'

/** Preserve Host/Origin/cookies; DSH owns all authentication and route checks. */
export function createDevelopmentProxy(pfx: Buffer, upstreamPort: number): { server: Server; close(): Promise<void> } {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw new Error('Invalid upstream port')
  const sockets = new Set<Duplex>()
  const server = createServer({ pfx, maxHeaderSize: 16384 }, (incoming, outgoing) => {
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) { outgoing.writeHead(400).end(); return }
    const upstream = requestHttp({ hostname: '127.0.0.1', port: upstreamPort, path: incoming.url, method: incoming.method,
      headers: incoming.headers, timeout: 60000 }, response => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing) })
    upstream.on('timeout', () => { upstream.destroy(new Error('upstream timeout')) })
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('Development DSH unavailable') })
    incoming.on('aborted', () => { upstream.destroy() })
    outgoing.on('close', () => { upstream.destroy() })
    incoming.pipe(upstream)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  server.on('upgrade', (request, downstream, head) => {
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) { downstream.destroy(); return }
    const upstream = connect(upstreamPort, '127.0.0.1')
    sockets.add(upstream)
    upstream.once('close', () => { sockets.delete(upstream); downstream.destroy() })
    downstream.once('close', () => { upstream.destroy() })
    upstream.on('error', () => { downstream.destroy() })
    downstream.on('error', () => { upstream.destroy() })
    upstream.once('connect', () => {
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`)
      for (let i = 0; i < request.rawHeaders.length; i += 2) upstream.write(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`)
      upstream.write('\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(downstream).pipe(upstream)
    })
  })
  server.maxConnections = 64
  return { server, close: async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }) } }
}
