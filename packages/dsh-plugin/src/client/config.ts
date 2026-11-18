/** Read Host-owned UI budgets before issuing association actions. */
import type { ProxyUiConfig } from '../ui/types.ts'
import type { ProxyFetch } from './controller.ts'
import { Config } from '../ui/config.ts'
import { responseObject } from './response.ts'

/**
 * Validate the client configuration received from the host.
 * @param bootstrap - Client Loader defaults bounding the initial configuration request.
 * @param fetch - same-origin browser transport.
 * @param signal - plugin lifetime.
 * @returns the Host's validated deployment budgets.
 */
export async function readUiConfig(bootstrap: ProxyUiConfig, fetch: ProxyFetch, signal: AbortSignal): Promise<ProxyUiConfig> {
  const stop = new AbortController()
  const combined = AbortSignal.any([signal, stop.signal])
  const timer = setTimeout(() => { stop.abort() }, bootstrap.requestTimeoutMs)
  try {
    combined.throwIfAborted()
    const response = await fetch('/api/mcp-proxy/ui-config', { method: 'GET', credentials: 'same-origin', signal: combined })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error('Configuration unavailable')
    }
    // The fixed protocol response contains exactly five numeric budget fields.
    const value = await responseObject(response, 512, combined)
    const keys = ['pollIntervalMs', 'statusIntervalMs', 'associationTimeoutMs', 'requestTimeoutMs', 'maxResponseBytes']
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid configuration')
    return Config(value as unknown as ProxyUiConfig)
  } catch (_error) { throw new Error('MCP proxy UI configuration unavailable') }
  finally { clearTimeout(timer) }
}
