/** Failure cleanup observes the entire owned process scope independently from its direct child. */
import { setTimeout as delay } from 'node:timers/promises'
/** Process observations and signalling supplied by the platform owner. */
export interface BackgroundOwner {
  readonly root: Promise<void>
  /** @returns whether the direct child has exited. */
  rootExited(): boolean
  /** @returns whether the owned process scope has any live member. */
  alive(): boolean
  /** @param signal - termination request for the complete owned scope. */
  signal(signal: NodeJS.Signals): void
}
/** Resolved grace, forced-reap and observation budgets. */
export interface BackgroundCleanupLimits { readonly graceMs: number; readonly reapMs: number; readonly pollMs: number }
/**
 * Resolve background startup ownership before detaching the service.
 * @param owner - exact process scope created during startup.
 * @param limits - cleanup budgets.
 * @returns after the root and scope settle; a surviving scope rejects after forced reap expires.
 */
export async function settleBackgroundOwner(owner: BackgroundOwner, limits: BackgroundCleanupLimits): Promise<void> {
  const grace = performance.now() + limits.graceMs
  let reap: number | undefined
  for (;;) {
    const alive = owner.alive()
    if (!alive && owner.rootExited()) { await owner.root; return }
    if (reap === undefined && (owner.rootExited() || performance.now() >= grace)) {
      owner.signal('SIGKILL')
      reap = performance.now() + limits.reapMs
      continue
    }
    if (reap !== undefined && performance.now() >= reap) throw new Error('Local MCP background cleanup failed')
    await delay(limits.pollMs)
  }
}
