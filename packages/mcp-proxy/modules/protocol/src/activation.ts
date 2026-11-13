/** Versioned OS activation containing only origin and a browser-bound opaque transaction. */
import type { AssociationRequestId } from './associations.ts'
import type { ProxyFrame, GenerationId } from './protocol.ts'

/** Validated activation; origin alone grants no authority without ticket redemption and device proof. */
export type ProxyActivation = { readonly kind: 'legacy'; readonly requestId: AssociationRequestId }
  | { readonly kind: 'pair'; readonly requestId: AssociationRequestId; readonly origin: string }

/**
 * Validate the URI without executing or trusting its contents.
 * @param uri - untrusted operating-system argument.
 * @returns validated request without executing or trusting it.
 */
export function parseProxyActivation(uri: string): ProxyActivation {
  try {
    if (new TextEncoder().encode(uri).byteLength > 4096 || /[\u0000-\u0020\u007f]/u.test(uri)) throw new Error('Invalid URI bytes')
    const url = new URL(uri)
    const requestId = url.pathname.slice(1)
    if (url.protocol !== 'mcp-proxy:' || url.host !== 'associate' || url.username || url.password || url.hash
      || !/^[A-Za-z0-9_-]{43}$/.test(requestId)) throw new Error('Invalid activation fields')
    if (!url.search) return { kind: 'legacy', requestId: requestId as AssociationRequestId }
    const entries = [...url.searchParams]
    const origin = url.searchParams.get('origin')
    if (entries.length !== 2 || url.searchParams.get('v') !== '2' || origin === null
      || entries.some(([key]) => key !== 'v' && key !== 'origin')) throw new Error('Invalid activation query')
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('Invalid activation origin')
    return { kind: 'pair', requestId: requestId as AssociationRequestId, origin }
  } catch (_error) {
    // Activation arguments contain one-use bearer material and are never echoed.
    throw new Error('Invalid mcp-proxy activation')
  }
}

/**
 * Create a versioned origin-bound browser activation URI.
 * @param origin - canonical deployment HTTPS origin.
 * @param requestId - browser transaction.
 * @returns versioned activation URI.
 */
export function proxyActivationUri(origin: string, requestId: AssociationRequestId): string {
  const url = new URL(`mcp-proxy://associate/${requestId}`)
  url.searchParams.set('v', '2')
  url.searchParams.set('origin', origin)
  parseProxyActivation(url.href)
  return url.href
}

/**
 * Construct the origin-bound proof challenge for ticket redemption.
 * @param origin - approved HTTPS origin.
 * @param requestId - one-use pairing nonce.
 * @returns domain-separated proof challenge.
 */
export function pairingChallenge(origin: string, requestId: AssociationRequestId): Extract<ProxyFrame, { kind:'challenge' }> {
  return { v: 1, kind: 'challenge', origin, generation: 'pairing' as GenerationId, nonce: requestId }
}
