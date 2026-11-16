/** Process-held crash protection using the public DSH Win32 binding table. */
import { isNullPtr, throwLastError, type Win32ProcessBindings, type NativePtr } from '@deepseek-ai/dsh-win32-process'
import { setTimeout as delay } from 'node:timers/promises'

/** A Job handle released only after its descendants have stopped. */
export interface CurrentProcessJob {
  release(options: { readonly timeoutMs: number; readonly pollIntervalMs: number }): Promise<void>
}

/** @param api - Public binding table. @param currentProcess - Borrowed current-process handle. @returns Owned crash-protection Job. */
export function holdCurrentProcessJob(api: Win32ProcessBindings, currentProcess: NativePtr, architecture: NodeJS.Architecture = process.arch): CurrentProcessJob {
  const job = api.createJobObjectW(null, null)
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW')
  const structureSize = architecture === 'ia32' ? 112 : 144
  const limits = Buffer.alloc(structureSize)
  limits.writeUInt32LE(0x2000, 16)
  try {
    if (api.setInformationJobObject(job, 9, limits, limits.length) === 0) throwLastError(api, 'SetInformationJobObject')
    if (api.assignProcessToJobObject(job, currentProcess) === 0) throwLastError(api, 'AssignProcessToJobObject')
  } catch (error) { api.closeHandle(job); throw error }
  let releasing: Promise<void> | undefined
  const release = async (options: { timeoutMs: number; pollIntervalMs: number }): Promise<void> => {
    const deadline = performance.now() + options.timeoutMs
    for (;;) {
      const accounting = Buffer.alloc(48)
      if (api.queryInformationJobObject(job, 1, accounting, accounting.length, null) === 0) throwLastError(api, 'QueryInformationJobObject')
      const count = accounting.readUInt32LE(40)
      if (count === 1) break
      const remaining = deadline - performance.now()
      if (count === 0 || remaining <= 0) throw new Error(`Service Job retains ${count} active processes`)
      await delay(Math.min(options.pollIntervalMs, remaining))
    }
    const disarmed = Buffer.alloc(structureSize)
    if (api.setInformationJobObject(job, 9, disarmed, disarmed.length) === 0) throwLastError(api, 'SetInformationJobObject')
    if (api.closeHandle(job) === 0) throwLastError(api, 'CloseHandle')
  }
  return { release: options => releasing ??= release(options) }
}
