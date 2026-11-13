/** Observe real HTTP bodies without changing the bytes delivered to Connection. */
import { createServer, request as httpRequest, type ClientRequest } from 'node:http'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { observePrompt } from '../src/prompt.ts'
import { promptAdmissionId } from '@j-show/dsh-mcp-proxy-host'

const envelope = (payload: unknown, method = 'session/prompt') => ({ type: 'client-request', rpcId: 'wire', method, payload })

async function exchange(body: string, options: { encoding?: boolean; dispose?: boolean; limit?: number; splitAt?: number } = {}) {
  let identity: ReturnType<ReturnType<typeof observePrompt>['identity']>
  let earlyIdentity: typeof identity
  let firstSeen = false
  let receivedBytes = 0
  const prefixBytes = options.splitAt === undefined ? 0 : Buffer.byteLength(body.slice(0, options.splitAt))
  let outgoing: ClientRequest | undefined
  const sockets = new Set<Socket>()
  const firstChunk = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<undefined>()
  const server = createServer((request, response) => {
    if (options.encoding) request.setEncoding('utf8')
    const observer = observePrompt(request, options.limit ?? 65536)
    if (options.dispose) observer.dispose()
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk)
      chunks.push(bytes)
      receivedBytes += bytes.byteLength
      if (!firstSeen && receivedBytes >= prefixBytes) {
        firstSeen = true
        earlyIdentity = observer.identity()
        firstChunk.resolve(undefined)
      }
    })
    request.on('end', () => {
      identity = observer.identity()
      observer.dispose()
      response.end(Buffer.concat(chunks))
    })
    request.on('close', () => { identity = observer.identity(); observer.dispose(); finished.resolve(undefined) })
    request.resume()
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  onTestFinished(async () => {
    outgoing?.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((done) => { server.close(() => { done() }) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected HTTP fixture address')
  const received = await new Promise<string>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: address.port, method: 'POST' }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    })
    outgoing = request
    request.on('error', (error) => {
      if (options.limit !== undefined && 'code' in error && error.code === 'ECONNRESET') resolve('connection-reset')
      else reject(error)
    })
    if (options.splitAt === undefined) request.end(body)
    else {
      request.write(body.slice(0, options.splitAt))
      void firstChunk.promise.then(() => { request.end(body.slice(options.splitAt)) }).catch(reject)
    }
  })
  await finished.promise
  return { identity, received, ...(options.splitAt === undefined ? {} : { earlyIdentity }) }
}

it.each([false, true])('observes the exact identity while retaining original HTTP bytes, text encoding=%s', async (encoding) => {
  const body = JSON.stringify(envelope({ args: { request: { sessionId: '会话', requestId: 'submission', content: 'unchanged' } } }))
  expect(await exchange(body, { encoding })).toEqual({ identity: promptAdmissionId('会话', 'submission'), received: body })
})

it.each([
  'not JSON', 'null', '[]', '{}',
  JSON.stringify(envelope(null)), JSON.stringify(envelope([])), JSON.stringify(envelope({ args: null })),
  JSON.stringify(envelope({ args: { request: [] } })),
  JSON.stringify(envelope({ args: { request: { sessionId: 1, requestId: 'request' } } })),
  JSON.stringify(envelope({ args: { request: { sessionId: 'session' } } })),
  JSON.stringify(envelope({ args: { request: { sessionId: 'session', requestId: 'request' } } }, 'session/updateQueue')),
])('grants no authority from malformed or non-prompt input %#', async (body) => {
  expect(await exchange(body)).toEqual({ identity: undefined, received: body })
})

it('removes its observers before a body is consumed', async () => {
  const body = JSON.stringify(envelope({ args: { request: { sessionId: 'session', requestId: 'request' } } }))
  expect(await exchange(body, { dispose: true })).toEqual({ identity: undefined, received: body })
})

it('closes an oversized body without granting partial-input authority', async () => {
  expect(await exchange('x'.repeat(128), { limit: 16 })).toEqual({ identity: undefined, received: 'connection-reset' })
})

it('does not admit a complete JSON prefix before end when a later chunk exceeds the limit', async () => {
  const prefix = JSON.stringify(envelope({ args: { request: { sessionId: 'session', requestId: 'request' } } }))
  expect(await exchange(prefix + ' '.repeat(128), { splitAt: prefix.length, limit: Buffer.byteLength(prefix) + 1 }))
    .toEqual({ identity: undefined, earlyIdentity: undefined, received: 'connection-reset' })
})
