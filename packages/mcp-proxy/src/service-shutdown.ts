/** PID-fenced GUI shutdown without stopping a replacement local owner. */
import { setTimeout as delay } from 'node:timers/promises'
export interface DesktopShutdownSpec {
  readonly expectedPid: number | undefined
  readonly status: () => Promise<{ readonly pid:number } | undefined>
  readonly stop: (pid:number) => Promise<void>
  readonly exited: () => boolean
  readonly timeoutMs: number
  readonly pollMs: number
}
/** @param spec - exact observed service and cleanup operations. @returns after that owner exits; another owner is never stopped. */
export async function stopDesktopService(spec: DesktopShutdownSpec): Promise<void> {
  if (spec.expectedPid === undefined) return
  let requested = false
  const deadline = performance.now() + spec.timeoutMs
  while (performance.now() < deadline) {
    const status = await spec.status()
    if (!requested && status?.pid === spec.expectedPid) { await spec.stop(spec.expectedPid); requested = true }
    if ((status === undefined || status.pid !== spec.expectedPid) && spec.exited()) return
    await delay(spec.pollMs)
  }
  throw new Error('Local service stop deadline')
}
