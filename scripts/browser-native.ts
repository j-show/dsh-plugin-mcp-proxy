/** Build and call the repository-owned Windows UIA test helper. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { eventually } from './browser-cdp.ts'
const execute = promisify(execFile)
/** Retry only known pre-input refusals; timeouts and uncertain dispatch are never replayed. */
export async function confirmNativeProtocol(action: () => Promise<unknown>): Promise<void> {
  let failure: unknown = new Error('Native confirmation target unavailable')
  try {
    await eventually(async () => {
      try { await action(); return true }
      catch (error) {
        failure = error
        const message = error instanceof Error ? error.message : ''
        if (!message.startsWith('Native operation confirm-protocol failed: Native desktop test: ')
          || message.includes('input result uncertain') || message.includes('(timeout)')) throw error
        return false
      }
    }, 'real browser protocol confirmation')
  } catch { throw failure }
}
export interface NativeWindow { pid: number; started: string; visible: boolean; image: string; handle: string; owned: boolean }
export async function compileDesktopProbe(directory: string): Promise<string> {
  const framework = join(process.env.WINDIR ?? '', 'Microsoft.NET/Framework64/v4.0.30319')
  const output = join(directory, 'desktop-probe.exe')
  await execute(join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:exe', `/out:${output}`,
    '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(name => `/reference:${join(framework, 'WPF', name + '.dll')}`),
    join(import.meta.dirname, 'native/BrowserDesktopProbe.cs')], { windowsHide: true, timeout: 30000 })
  return output
}
export async function nativeProbe<T>(helper: string, operation: string, ...args: string[]): Promise<T> {
  let confirmation: ReturnType<typeof setInterval> | undefined
  let busy = false
  try {
    const certificateOperation = operation === 'ca-add' || operation === 'ca-remove'
    const pending = execute(helper, [operation, ...args], { windowsHide: true, timeout: certificateOperation ? 45000 : 20000, maxBuffer: 1048576 })
    const identity = certificateOperation && pending.child.pid
      ? nativeProbe<{ pid: number; started: string; image: string }>(helper, 'identity', String(pending.child.pid)).catch(() => undefined)
      : Promise.resolve(undefined)
    if (certificateOperation) confirmation = setInterval(() => {
      if (busy || pending.child.exitCode !== null) return
      busy = true
      void (async () => {
        try {
          const target = await identity
          if (target && pending.child.exitCode === null && resolve(target.image).toLowerCase() === resolve(helper).toLowerCase()) await nativeProbe(helper, 'confirm-ca', String(target.pid), target.started)
        } catch { /* A warning may not be shown; the actual import result remains authoritative. */ }
        finally { busy = false }
      })()
    }, 750)
    const result = await pending
    return JSON.parse(result.stdout) as T
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : ''
    const reason = error && typeof error === 'object' && 'killed' in error && error.killed ? ' (timeout)' : ''
    throw new Error(`Native operation ${operation} failed${reason}${detail ? ': ' + detail : ''}`)
  } finally { clearInterval(confirmation) }
}
