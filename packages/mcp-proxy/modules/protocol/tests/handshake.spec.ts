import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { acceptProxyIdentity, proveProxyIdentity, type AuthenticatedProxy } from '../src/handshake.ts'
import { ProxyChannel } from '../src/channel.ts'
import { ProxyIdentity } from '../src/identity.ts'
import { decodeFrame } from '../src/protocol.ts'
import { openSockets } from './helpers/sockets.ts'

const options = { maxFrameBytes: 4096, timeoutMs: 10000 }
const origin = 'https://agent.example'

it('proves identity across real sockets before transferring the authenticated generation', async () => {
  const { client, remote } = await openSockets()
  const identity = ProxyIdentity.generate()
  const accepted = acceptProxyIdentity(remote, origin, options, () => {})
  const proved = proveProxyIdentity(client, identity, origin, options, () => {})
  const [server, local] = await Promise.all([accepted, proved])
  expect(server.endpointId).toBe(identity.endpointId)
  expect(server.generation).toBeTruthy()
  expect(local).toEqual(server)
})

it('rejects a server origin mismatch without granting a connection', async () => {
  const { client, remote } = await openSockets()
  const accepted = acceptProxyIdentity(remote, origin, options, () => {})
  const rejectedServer = expect(accepted).rejects.toThrow('MCP proxy handshake failed')
  const local = proveProxyIdentity(client, ProxyIdentity.generate(), 'https://other.example', options, () => {})
  await expect(local).rejects.toThrow('MCP proxy handshake failed')
  await rejectedServer
})

it('rejects tampered registration on the same connection', async () => {
  const { client, remote } = await openSockets()
  const received = once(client, 'message')
  const accepted = acceptProxyIdentity(remote, origin, options, () => {})
  const rejected = expect(accepted).rejects.toThrow('MCP proxy handshake failed')
  const [raw] = await received
  const challenge = decodeFrame(String(raw), 4096)
  if (challenge.kind !== 'challenge') throw new Error('Expected challenge')
  const frame = ProxyIdentity.generate().registration(challenge, origin)
  client.send(JSON.stringify({ ...frame, signature: 'A'.repeat(86) }))
  await rejected
})

it.each(['wrong-endpoint', 'wrong-generation', 'wrong-phase'])('rejects a %s acknowledgement without transferring ownership', async (fault) => {
  const { client, remote } = await openSockets()
  const identity = ProxyIdentity.generate()
  let transfers = 0
  const proof = proveProxyIdentity(client, identity, origin, options, () => { transfers++ })
  const rejected = expect(proof).rejects.toThrow('MCP proxy handshake failed')
  const registration = once(remote, 'message')
  remote.send(JSON.stringify({ v: 1, kind: 'challenge', generation: 'g', nonce: 'n', origin }))
  await registration
  remote.send(JSON.stringify(fault === 'wrong-phase'
    ? { v: 1, kind: 'ping' }
    : { v: 1, kind: 'ready', generation: fault === 'wrong-generation' ? 'other' : 'g',
      endpointId: fault === 'wrong-endpoint' ? ProxyIdentity.generate().endpointId : identity.endpointId }))
  await rejected
  expect(transfers).toBe(0)
  expect(client.listenerCount('message')).toBe(0)
})

it.each(['binary', 'malformed', 'wrong-phase'])('refuses a %s initial registration frame', async (fault) => {
  const { client, remote } = await openSockets()
  const incoming = once(client, 'message')
  let transfers = 0
  const accepted = acceptProxyIdentity(remote, origin, options, () => { transfers++ })
  const rejected = expect(accepted).rejects.toThrow('MCP proxy handshake failed')
  const [raw] = await incoming
  const challenge = decodeFrame(String(raw), options.maxFrameBytes)
  if (challenge.kind !== 'challenge') throw new Error('Expected challenge')
  const registration = JSON.stringify(ProxyIdentity.generate().registration(challenge, origin))
  client.send(fault === 'malformed' ? '{private-invalid-json' : fault === 'wrong-phase' ? JSON.stringify({ v: 1, kind: 'ping' }) : registration,
    { binary: fault === 'binary' })
  await rejected
  expect(transfers).toBe(0)
  expect(remote.listenerCount('message')).toBe(0)
})

it('fails closed when installing the authenticated successor throws', async () => {
  const { client, remote } = await openSockets()
  const incoming = once(client, 'message')
  const accepted = acceptProxyIdentity(remote, origin, options, () => { throw new Error('private-successor-failure') })
  const rejected = expect(accepted).rejects.toThrow('MCP proxy handshake failed')
  const [raw] = await incoming
  const challenge = decodeFrame(String(raw), options.maxFrameBytes)
  if (challenge.kind !== 'challenge') throw new Error('Expected challenge')
  client.send(JSON.stringify(ProxyIdentity.generate().registration(challenge, origin)))
  await rejected
  expect(remote.listenerCount('message')).toBe(0)
})

it('rejects initialization on an already closed socket', async () => {
  const { client } = await openSockets()
  const closed = once(client, 'close')
  client.close()
  await closed
  await expect(proveProxyIdentity(client, ProxyIdentity.generate(), origin, options, () => {}))
    .rejects.toThrow('MCP proxy handshake failed')
  expect(client.listenerCount('message')).toBe(0)
})

it.each([{ maxFrameBytes: 0, timeoutMs: 1000 }, { maxFrameBytes: 4096, timeoutMs: 0 },
  { maxFrameBytes: 4096, timeoutMs: 2147483648 }])('rejects invalid handshake limits before registering listeners %#', async (limits) => {
  const { client } = await openSockets()
  await expect(proveProxyIdentity(client, ProxyIdentity.generate(), origin, limits, () => {}))
    .rejects.toThrow('MCP proxy handshake limits are invalid')
  expect(client.listenerCount('message')).toBe(0)
})

it('expires a handshake whose peer never answers', async () => {
  const { remote } = await openSockets()
  await expect(acceptProxyIdentity(remote, origin, { ...options, timeoutMs: 100 }, () => {})).rejects.toThrow('MCP proxy handshake failed')
})

it('installs the successor synchronously when ready and invocation share a TCP write batch', async () => {
  const { client, remote, carrier } = await openSockets()
  const identity = ProxyIdentity.generate()
  const owned: { channel?: ProxyChannel } = {}
  let calls = 0
  onTestFinished(async () => { await owned.channel?.close() })
  const seen = Promise.withResolvers<undefined>()
  client.on('message', (data) => {
    if (decodeFrame(String(data), 4096).kind === 'invoke') seen.resolve(undefined)
  })
  const proof = proveProxyIdentity(client, identity, origin, options, (peer: AuthenticatedProxy) => {
    owned.channel = new ProxyChannel(client, { generation: peer.generation, maxFrameBytes: 4096, maxInvocations: 3, maxPending: 1,
      onInvoke: async () => { calls++; return { content: [] } },
    })
  })
  const registration = once(remote, 'message')
  remote.send(JSON.stringify({ v: 1, kind: 'challenge', generation: 'g', nonce: 'n', origin }))
  await registration
  carrier.cork()
  remote.send(JSON.stringify({ v: 1, kind: 'ready', generation: 'g', endpointId: identity.endpointId }))
  remote.send(JSON.stringify({ v: 1, kind: 'invoke', generation: 'g', id: 'early', revision: 'r', service: 'files', name: 'read', args: {}, timeoutMs: 10000 }))
  carrier.uncork()
  await proof
  await seen.promise
  expect(calls).toBe(1)
})

it('transfers server ownership before processing a registration and invocation batch', async () => {
  const { client, remote, clientCarrier } = await openSockets()
  const identity = ProxyIdentity.generate()
  const owned: { channel?: ProxyChannel } = {}
  let calls = 0
  onTestFinished(async () => { await owned.channel?.close() })
  const incoming = once(client, 'message')
  const accepted = acceptProxyIdentity(remote, origin, options, (peer) => {
    owned.channel = new ProxyChannel(remote, { generation: peer.generation, maxFrameBytes: 4096, maxInvocations: 3, maxPending: 1,
      onInvoke: async () => { calls++; return { content: [] } },
    })
  })
  const [raw] = await incoming
  const challenge = decodeFrame(String(raw), 4096)
  if (challenge.kind !== 'challenge') throw new Error('Expected challenge')
  clientCarrier.cork()
  client.send(JSON.stringify(identity.registration(challenge, origin)))
  client.send(JSON.stringify({ v: 1, kind: 'invoke', generation: challenge.generation, id: 'early', revision: 'r', service: 'files', name: 'read', args: {}, timeoutMs: 10000 }))
  clientCarrier.uncork()
  await accepted
  expect(calls).toBe(1)
})
