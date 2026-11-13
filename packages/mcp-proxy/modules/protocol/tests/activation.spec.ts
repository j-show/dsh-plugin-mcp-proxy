import { expect, it } from 'vitest'
import type { AssociationRequestId } from '../src/associations.ts'
import { parseProxyActivation, proxyActivationUri, pairingChallenge } from '../src/activation.ts'
import { ProxyIdentity, verifyRegistration } from '../src/identity.ts'

const id = 'a'.repeat(43) as AssociationRequestId
it('carries a canonical origin for first approval without carrying account credentials', () => {
  const uri = proxyActivationUri('https://dsh.example:8443', id)
  expect(parseProxyActivation(uri)).toEqual({ kind: 'pair', requestId: id, origin: 'https://dsh.example:8443' })
  expect(parseProxyActivation(`mcp-proxy://associate/${id}`)).toEqual({ kind: 'legacy', requestId: id })
})

it.each([
  `mcp-proxy://associate/${id}?v=2&origin=http%3A%2F%2Fdsh.example`,
  `mcp-proxy://associate/${id}?v=2&origin=https%3A%2F%2Fdsh.example%2Fpath`,
  `mcp-proxy://associate/${id}?v=2&origin=https%3A%2F%2Fdsh.example&command=run`,
  `mcp-proxy://associate/${id}?v=2&origin=https%3A%2F%2Fa.example&origin=https%3A%2F%2Fb.example`,
  `mcp-proxy://user@associate/${id}`, `mcp-proxy://associate/${id}#run`,
])('rejects invalid or ambiguous activation without echoing its contents', uri => {
  expect(() => parseProxyActivation(uri)).toThrow('Invalid mcp-proxy activation')
})

it('binds the registration signature to both origin and one-use ticket', () => {
  const identity = ProxyIdentity.generate()
  const challenge = pairingChallenge('https://a.example', id)
  const proof = identity.registration(challenge, 'https://a.example')
  expect(verifyRegistration(proof, challenge)).toBe(identity.endpointId)
  expect(() => verifyRegistration(proof, pairingChallenge('https://b.example', id))).toThrow()
  expect(() => verifyRegistration(proof, pairingChallenge('https://a.example', 'b'.repeat(43) as AssociationRequestId))).toThrow()
})
