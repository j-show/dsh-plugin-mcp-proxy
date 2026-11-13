/** Ed25519 installation identity and server-bound registration proofs. */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import type { EndpointId } from './associations.ts'
import type { ProxyFrame } from './protocol.ts'
type Challenge = Extract<ProxyFrame, { kind: 'challenge' }>
type Registration = Extract<ProxyFrame, { kind: 'register' }>
function endpointOf(publicKey: KeyObject): EndpointId {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex') as EndpointId
}

function proofBytes(challenge: Challenge, endpoint: EndpointId, publicKey: string): Buffer {
  return Buffer.from(JSON.stringify([1, 'mcp-proxy-register', challenge.origin, challenge.generation, challenge.nonce, endpoint, publicKey]))
}

/** Installation key owner; only explicit export exposes the private key for protected storage. */
export class ProxyIdentity {
  /** Self-certifying identity derived from the SPKI public-key bytes. */
  readonly endpointId: EndpointId
  /** Public registration key; safe to transmit to the configured server. */
  readonly publicKey: string

  private constructor(private readonly key: KeyObject) {
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid MCP proxy private key')
    const publicKey = createPublicKey(key)
    this.endpointId = endpointOf(publicKey)
    this.publicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }

  /**
   * Create a new Ed25519 installation identity.
   * @returns a new installation identity; the owner must persist its private key securely.
   */
  static generate(): ProxyIdentity {
    return new ProxyIdentity(generateKeyPairSync('ed25519').privateKey)
  }

  /**
   * Restore a protected installation key without exposing malformed key data in diagnostics.
   * @param encoded - PKCS8 PEM private key from owner-only storage.
   * @returns the same stable installation identity, or throws a non-secret key error.
   */
  static restore(encoded: string): ProxyIdentity {
    try {
      return new ProxyIdentity(createPrivateKey(encoded))
    } catch (_error) {
      throw new Error('Invalid MCP proxy private key')
    }
  }

  /**
   * Export the installation private key for protected credential storage.
   * @returns secret PKCS8 PEM for owner-only storage; never send it on the channel or log it.
   */
  exportPrivateKey(): string {
    return this.key.export({ type: 'pkcs8', format: 'pem' }).toString()
  }

  /**
   * Bind registration to the server origin, generation and fresh nonce.
   * @param challenge - current socket's parsed server challenge.
   * @param expectedOrigin - trusted server origin from local configuration.
   * @returns public identity and signature, with no private key material.
   */
  registration(challenge: Challenge, expectedOrigin: string): Registration {
    if (challenge.origin !== expectedOrigin) throw new Error('Unexpected MCP proxy server origin')
    return {
      v: 1, kind: 'register', endpointId: this.endpointId, publicKey: this.publicKey,
      signature: sign(null, proofBytes(challenge, this.endpointId, this.publicKey), this.key).toString('base64url'),
    }
  }
}

/**
 * Verify the device claim against the exact challenge issued for this connection.
 * @param frame - parsed registration reply, not a browser-provided endpoint claim.
 * @param challenge - owner-retained unexpired, unconsumed challenge for the socket.
 * @returns authenticated endpoint identity; throws a non-secret proof error otherwise.
 */
export function verifyRegistration(frame: Registration, challenge: Challenge): EndpointId {
  try {
    const key = createPublicKey(frame.publicKey)
    const endpoint = endpointOf(key)
    if (key.asymmetricKeyType !== 'ed25519' || endpoint !== frame.endpointId
      || !/^[A-Za-z0-9_-]{86}$/.test(frame.signature)
      || !verify(null, proofBytes(challenge, endpoint, frame.publicKey), key, Buffer.from(frame.signature, 'base64url'))) {
      throw new Error('Invalid MCP proxy identity proof')
    }
    return endpoint
  } catch (_error) {
    throw new Error('Invalid MCP proxy identity proof')
  }
}
