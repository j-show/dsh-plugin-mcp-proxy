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
export interface BackgroundCleanupLimits { readonly graceMs: number; readonly reapMs: number; readonly pollMs: number; readonly fallbackSignal?: 'SIGTERM' }
/**
 * Resolve background startup ownership before detaching the service.
 * @param owner - exact process scope created during startup.
 * @param limits - cleanup budgets.
 * @returns after the root and scope settle; a surviving scope rejects after forced reap expires.
 */
export async function settleBackgroundOwner(owner: BackgroundOwner, limits: BackgroundCleanupLimits): Promise<void> {
  const grace = performance.now() + limits.graceMs
  const deadline = grace + limits.reapMs
  let reap: number | undefined
  let uncertain = false, signalDenied = false, forced = false, fallback = false
  let permissionError: unknown
  const permissionDenied = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  const signal = (value: NodeJS.Signals) => {
    try { owner.signal(value) } catch (error) {
      if (!permissionDenied(error)) throw error
      permissionError = error; uncertain = true; signalDenied = true
    }
  }
  for (;;) {
    let alive: boolean | undefined
    try { alive = owner.alive() } catch (error) {
      if (!permissionDenied(error)) throw error
      permissionError = error; uncertain = true
    }
    const exited = owner.rootExited(), now = performance.now()
    // EPERM is unknown, not absence. Only a later authoritative observation can finish custody.
    if (alive === false && exited) { await owner.root; return }
    if (now >= (reap ?? deadline)) throw new Error('Local MCP background cleanup failed', { cause: permissionError })
    if (!fallback) {
      fallback = true
      if (limits.fallbackSignal && alive === true && !uncertain) signal(limits.fallbackSignal)
    }
    if (reap === undefined && (exited || now >= grace)) reap = Math.min(deadline, now + limits.reapMs)
    // A denied signal is never retried. After uncertain presence, a reaped leader no longer anchors the group id.
    if (reap !== undefined && alive === true && !forced && !signalDenied && (!uncertain || !exited)) {
      forced = true; signal('SIGKILL')
    }
    await delay(limits.pollMs)
  }
}
