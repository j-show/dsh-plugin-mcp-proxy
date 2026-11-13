import { Context } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { pairingChallenge, verifyRegistration, decodeFrame, type AssociationRequestId } from '@j-show/mcp-proxy-protocol'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { pairDshDevice } from '../src/device-client.ts'

it('redeems through verified HTTPS with a persistent per-origin key and no deployment/account credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-device-client-'))
  const ctx = new Context()
  const caFile = fileURLToPath(new URL('./fixtures/localhost-cert.pem', import.meta.url))
  let origin = ''
  const endpoints: string[] = []
  const server = createServer({ cert: await readFile(caFile), key: await readFile(new URL('./fixtures/localhost-key.pem', import.meta.url)) },
    async (request, response) => {
      expect(request.url).toBe('/mcp-proxy/pair')
      expect(request.headers.authorization).toBeUndefined()
      expect(request.headers.cookie).toBeUndefined()
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const value = JSON.parse(Buffer.concat(chunks).toString()) as { requestId: AssociationRequestId; registration: unknown }
      const registration = decodeFrame(JSON.stringify(value.registration), 65536)
      if (registration.kind !== 'register') throw new Error('Expected public proof')
      const endpointId = verifyRegistration(registration, pairingChallenge(origin, value.requestId))
      endpoints.push(endpointId)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ endpointId, upgradePath: '/custom/mcp' }))
    })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Credentials, { path: join(root, 'identity.yaml'), watch: false })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TLS listener')
  origin = `https://127.0.0.1:${address.port}`
  const options = { timeoutMs: 2000, maxResponseBytes: 8192 }
  const first = await pairDshDevice({ kind: 'pair', origin, requestId: 'a'.repeat(43) as AssociationRequestId },
    ctx.credentials, options, new AbortController().signal, caFile)
  const second = await pairDshDevice({ kind: 'pair', origin, requestId: 'b'.repeat(43) as AssociationRequestId },
    ctx.credentials, options, new AbortController().signal, caFile, first)
  expect(first.upgradePath).toBe('/custom/mcp')
  expect(second.identityRef).toBe(first.identityRef)
  expect(second.id).toBe(first.id)
  expect(endpoints[0]).toBe(endpoints[1])
})
