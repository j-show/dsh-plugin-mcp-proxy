/** Browser-owned association polling and response budgets, validated by the Host entry. */
export interface ProxyUiConfig {
  /** Pending association polling interval in milliseconds. */
  readonly pollIntervalMs: number
  /** Established association status polling interval in milliseconds. */
  readonly statusIntervalMs: number
  /** Browser association completion deadline in milliseconds. */
  readonly associationTimeoutMs: number
  /** Individual browser request deadline in milliseconds. */
  readonly requestTimeoutMs: number
  /** Maximum browser JSON response size in bytes. */
  readonly maxResponseBytes: number
}
