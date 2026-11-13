import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ProxyIdentity, verifyRegistration } from '../src/identity.ts'
import type { ProxyFrame } from '../src/protocol.ts'

const challenge: Extract<ProxyFrame, { kind: 'challenge' }> = {
  v: 1, kind: 'challenge', generation: 'generation-1' as Extract<ProxyFrame, { kind: 'challenge' }>['generation'],
  nonce: 'nonce-1', origin: 'https://agent.example',
}

describe('local proxy identity proof', () => {
  it('keeps installation identity across private-key restoration and separates installations', () => {
    const identity = ProxyIdentity.generate()
    const restored = ProxyIdentity.restore(identity.exportPrivateKey())
    expect(restored.endpointId).toBe(identity.endpointId)
    expect(restored.publicKey).toBe(identity.publicKey)
    expect(ProxyIdentity.generate().endpointId).not.toBe(identity.endpointId)
  })

  it('proves the claimed installation through the full server challenge', () => {
    const identity = ProxyIdentity.generate()
    const frame = identity.registration(challenge, 'https://agent.example')
    expect(verifyRegistration(frame, challenge)).toBe(identity.endpointId)
  })

  it('uses the SPKI DER digest as the external endpoint identity', () => {
    const identity = ProxyIdentity.generate()
    const bytes = createPublicKey(identity.publicKey).export({ type: 'spki', format: 'der' })
    expect(identity.endpointId).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('rejects a well-formed signature whose bytes were changed', () => {
    const identity = ProxyIdentity.generate()
    const frame = identity.registration(challenge, 'https://agent.example')
    const signature = (frame.signature.startsWith('A') ? 'B' : 'A') + frame.signature.slice(1)
    expect(() => verifyRegistration({ ...frame, signature }, challenge)).toThrow('Invalid MCP proxy identity proof')
  })

  it.each(['nonce', 'generation', 'origin'] as const)('rejects replay against another %s', (field) => {
    const identity = ProxyIdentity.generate()
    const frame = identity.registration(challenge, 'https://agent.example')
    expect(() => verifyRegistration(frame, { ...challenge, [field]: 'different' })).toThrow('Invalid MCP proxy identity proof')
  })

  it('rejects replacing a registration public key while retaining a claimed device', () => {
    const identity = ProxyIdentity.generate()
    const frame = identity.registration(challenge, 'https://agent.example')
    expect(() => verifyRegistration({ ...frame, publicKey: ProxyIdentity.generate().publicKey }, challenge)).toThrow('Invalid MCP proxy identity proof')
  })

  it('refuses to sign a challenge for a server other than the configured origin', () => {
    expect(() => ProxyIdentity.generate().registration(challenge, 'https://other.example')).toThrow('Unexpected MCP proxy server origin')
  })

  it('does not include malformed key data in restoration errors', () => {
    expect(() => ProxyIdentity.restore('test-only-private-invalid-value')).toThrow(/^Invalid MCP proxy private key$/)
  })

  it('rejects an identity using an unsupported key algorithm', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    expect(() => ProxyIdentity.restore(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())).toThrow('Invalid MCP proxy private key')
  })
})
