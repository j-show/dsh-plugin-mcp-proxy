/** Socket identity proof exchange; deployment credential admission belongs to the upgrade owner. */
import { randomBytes, randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'
import { verifyRegistration, type ProxyIdentity } from './identity.ts'
import type { EndpointId } from './associations.ts'
import { decodeFrame, type ProxyFrame, type GenerationId } from './protocol.ts'
/** Deployment-resolved handshake resource limits. */
export interface HandshakeOptions { readonly maxFrameBytes: number; readonly timeoutMs: number }
/** Identity verified for one live socket generation, not a Session or user identity. */
export interface AuthenticatedProxy { readonly endpointId: EndpointId; readonly generation: GenerationId }

type Send = (frame: ProxyFrame) => void
type Complete = (peer: AuthenticatedProxy) => void

function exchange(
  socket: WebSocket, options: HandshakeOptions,
  receive: (frame: ProxyFrame, send: Send, complete: Complete) => void,
  ready: (peer: AuthenticatedProxy) => void,
  start?: (send: Send) => void,
): Promise<AuthenticatedProxy> {
  if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 1
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
    return Promise.reject(new RangeError('MCP proxy handshake limits are invalid'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const deadline = performance.now() + options.timeoutMs
    const timer = setTimeout(() => { fail() }, options.timeoutMs)
    timer.unref()
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('message', message)
      socket.off('error', fail)
      socket.off('close', fail)
    }
    const fail = (): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.terminate()
      reject(new Error('MCP proxy handshake failed'))
    }
    const complete: Complete = (peer) => {
      if (settled) return
      if (performance.now() >= deadline) { fail(); return }
      try {
        ready(peer)
      } catch (_error) {
        // Transfer ownership before removing the handshake listener, or fail closed.
        fail()
        return
      }
      settled = true
      cleanup()
      resolve(peer)
    }
    const send: Send = (frame) => {
      if (settled) return
      const payload = JSON.stringify(frame)
      decodeFrame(payload, options.maxFrameBytes)
      socket.send(payload, (error) => {
        if (error) { socket.terminate(); fail() }
      })
    }
    const message = (data: RawData, binary: boolean): void => {
      if (settled) return
      try {
        if (binary || performance.now() >= deadline) throw new Error('Invalid handshake phase')
        receive(decodeFrame(data.toString(), options.maxFrameBytes), send, complete)
      } catch (_error) {
        // Peer frames and key errors can contain identity material; do not echo them.
        fail()
      }
    }
    socket.on('message', message)
    socket.on('error', fail)
    socket.on('close', fail)
    try {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('Socket is not open')
      start?.(send)
    } catch (_error) {
      // Initialization failure must release the same listeners and timeout as peer failure.
      fail()
    }
  })
}

/**
 * Prove a connector identity after the upgrade owner admits its deployment credential.
 * @param socket - open credential-admitted socket with receiver payload limits configured.
 * @param origin - trusted deployment origin included in the challenge.
 * @param options - explicit handshake limits.
 * @param ready - synchronously install the successor's socket listeners before returning.
 * @returns verified connector identity and a fresh generation; protocol or successor failure terminates the socket.
 */
export function acceptProxyIdentity(
  socket: WebSocket, origin: string, options: HandshakeOptions, ready: (peer: AuthenticatedProxy) => void,
): Promise<AuthenticatedProxy> {
  const challenge: Extract<ProxyFrame, { kind: 'challenge' }> = {
    v: 1, kind: 'challenge', origin,
    generation: randomUUID() as GenerationId, nonce: randomBytes(32).toString('base64url'),
  }
  let consumed = false
  return exchange(socket, options, (frame, send, complete) => {
    if (consumed || frame.kind !== 'register') throw new Error('Expected one registration')
    consumed = true
    const endpointId = verifyRegistration(frame, challenge)
    send({ v: 1, kind: 'ready', endpointId, generation: challenge.generation })
    complete({ endpointId, generation: challenge.generation })
  }, ready, (send) => { send(challenge) })
}

/**
 * Answer the configured server's challenge before starting local invocation exchange.
 * @param socket - open server-authenticated socket (TLS verification belongs to its owner).
 * @param identity - local installation key owner.
 * @param origin - configured deployment origin, never taken from an incoming URI.
 * @param options - explicit handshake limits.
 * @param ready - synchronously install the successor's socket listeners before returning.
 * @returns the accepted local identity and connection generation; protocol or successor failure terminates the socket.
 */
export function proveProxyIdentity(
  socket: WebSocket, identity: ProxyIdentity, origin: string, options: HandshakeOptions,
  ready: (peer: AuthenticatedProxy) => void,
): Promise<AuthenticatedProxy> {
  let challenge: Extract<ProxyFrame, { kind: 'challenge' }> | undefined
  return exchange(socket, options, (frame, send, complete) => {
    if (challenge === undefined) {
      if (frame.kind !== 'challenge') throw new Error('Expected challenge')
      challenge = frame
      send(identity.registration(frame, origin))
      return
    }
    if (frame.kind !== 'ready' || frame.endpointId !== identity.endpointId || frame.generation !== challenge.generation) {
      throw new Error('Unexpected handshake acknowledgement')
    }
    complete({ endpointId: frame.endpointId, generation: frame.generation })
  }, ready)
}
