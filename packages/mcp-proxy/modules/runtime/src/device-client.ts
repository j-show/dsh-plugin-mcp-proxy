/** Activation-origin HTTPS ticket redemption; no account or deployment credential is sent. */
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { LocalDshSettings } from '@j-show/mcp-proxy-local'
import { pairingChallenge, ProxyIdentity, type ProxyActivation, type DshConnectionId } from '@j-show/mcp-proxy-protocol'
import { createHash, randomUUID } from 'node:crypto'
import { request as requestHttps } from 'node:https'
import type { ClientRequest } from 'node:http'
import { readFile } from 'node:fs/promises'

/** Explicit HTTPS response and wall-clock budgets. */
export interface DevicePairOptions { readonly timeoutMs: number; readonly maxResponseBytes: number }

/**
 * Redeem a browser ticket over verified TLS using a persistent per-origin device identity.
 * @param activation - parsed HTTPS origin from the activation.
 * @param credentials - profile-owned private identity storage.
 * @param options - HTTPS budgets.
 * @param signal - controller lifetime.
 * @param caFile - optional explicitly configured local trust root.
 * @param previous - existing entry whose local ID is retained.
 * @returns a device-mode entry only after the server confirms the same public identity.
 */
export async function pairDshDevice(activation: Extract<ProxyActivation, { kind:'pair' }>, credentials: CredentialProvider,
  options: DevicePairOptions, signal: AbortSignal, caFile?: string, previous?: LocalDshSettings): Promise<LocalDshSettings> {
  signal.throwIfAborted()
  if (previous !== undefined && previous.origin !== activation.origin) throw new Error('DSH origin does not match existing entry')
  const identityRef = 'MCP_PROXY_DEVICE_' + createHash('sha256').update(activation.origin).digest('hex').toUpperCase()
  const stored = await credentials.resolve(credentialRef(identityRef))
  const identity = stored === undefined ? ProxyIdentity.generate() : ProxyIdentity.restore(stored.value)
  if (stored === undefined) await credentials.set(credentialRef(identityRef), identity.exportPrivateKey())
  const ca = caFile === undefined ? undefined : await readFile(caFile)
  const body = JSON.stringify({ requestId: activation.requestId,
    registration: identity.registration(pairingChallenge(activation.origin, activation.requestId), activation.origin) })
  signal.throwIfAborted()
  let request: ClientRequest | undefined
  const abort = (): void => { request?.destroy(new Error('DSH pairing interrupted')) }
  const timer = setTimeout(abort, options.timeoutMs)
  timer.unref()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const text = await new Promise<string>((resolve, reject) => {
      request = requestHttps(new URL('/mcp-proxy/pair', activation.origin), { method: 'POST', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        ...(ca === undefined ? {} : { ca }),
      }, (response) => {
        if (response.statusCode !== 200) { reject(new Error('DSH pairing refused')); request?.destroy(); return }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxResponseBytes) { reject(new Error('DSH pairing response limit exceeded')); request?.destroy(); return }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('aborted', () => { reject(new Error('DSH pairing response interrupted')) })
        response.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
      })
      request.on('error', reject)
      request.end(body)
    })
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Object.keys(value).length !== 2
      || !('endpointId' in value) || value.endpointId !== identity.endpointId
      || !('upgradePath' in value) || typeof value.upgradePath !== 'string' || !/^\/[A-Za-z0-9/_-]+$/.test(value.upgradePath)) {
      throw new Error('DSH pairing response does not match device')
    }
    return { id: previous === undefined ? randomUUID() as DshConnectionId : previous.id,
      origin: activation.origin, enabled: true, mode: 'device', identityRef, upgradePath: value.upgradePath,
      ...(caFile === undefined ? {} : { caFile }) }
  } catch (_error) { throw new Error('DSH device pairing unavailable') }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); request?.destroy() }
}
