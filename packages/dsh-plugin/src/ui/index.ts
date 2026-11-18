/** Host discovery entry for the local-computer association UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ProxyUiConfig } from './types.ts'

export type { ProxyUiConfig } from './types.ts'
export { Config } from './config.ts'
/** Existing authenticated feature-route registry. */
export const inject = ['connection']
/** @param ctx - Host UI owner. @param config - Host-validated budgets exposed without unrelated configuration fields. */
export function apply(ctx: Context, config: ProxyUiConfig): void {
  const value: ProxyUiConfig = { pollIntervalMs: config.pollIntervalMs, statusIntervalMs: config.statusIntervalMs,
    associationTimeoutMs: config.associationTimeoutMs, requestTimeoutMs: config.requestTimeoutMs, maxResponseBytes: config.maxResponseBytes,
  }
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/mcp-proxy/ui-config', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json(value, { headers: { 'cache-control': 'no-store' } }),
  }))
}
