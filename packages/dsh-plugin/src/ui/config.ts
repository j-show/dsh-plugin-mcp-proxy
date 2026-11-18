/** Shared schema for Host UI settings and browser bootstrap defaults. */
import z from '@deepseek-ai/schemastery'
import type { ProxyUiConfig } from './types.ts'

/** Association polling, request and complete-response budgets. */
export const Config: z<ProxyUiConfig> = z.object({
  pollIntervalMs: z.natural().min(1).max(2147483647).default(500),
  statusIntervalMs: z.natural().min(1).max(2147483647).default(15000),
  associationTimeoutMs: z.natural().min(1).max(2147483647).default(30000),
  requestTimeoutMs: z.natural().min(1).max(2147483647).default(10000),
  maxResponseBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(65536),
})
