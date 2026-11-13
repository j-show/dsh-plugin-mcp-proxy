/** Bounded same-origin feature requests with explicit cancellation and deadlines. */
import type { ProxyUiConfig } from '../types.ts'
import type { ProxyFetch } from './controller.ts'
import { responseObject } from './response.ts'

/**
 * Send an authenticated same-origin request to the proxy controller.
 * @param config - deployment request and response budgets.
 * @param fetch - browser carrier.
 * @param route - plugin-owned path below its API prefix.
 * @param body - JSON request fields.
 * @param signal - owning page/plugin cancellation.
 * @returns bounded parsed response and status; no payload enters diagnostics.
 */
export async function proxyPost(config: ProxyUiConfig, fetch: ProxyFetch, route: string,
  body: Record<string, unknown>, signal: AbortSignal): Promise<{ status: number; value: Record<string, unknown> }> {
  const timeout = new AbortController()
  const combined = AbortSignal.any([signal, timeout.signal])
  const timer = setTimeout(() => { timeout.abort() }, config.requestTimeoutMs)
  try {
    combined.throwIfAborted()
    const response = await fetch(`/api/mcp-proxy/${route}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: combined,
    })
    return { status: response.status, value: await responseObject(response, config.maxResponseBytes, combined) }
  } finally { clearTimeout(timer) }
}
