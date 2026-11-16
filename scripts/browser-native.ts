/** Build and call the repository-owned Windows UIA test helper. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { eventually } from './browser-cdp.ts'
const execute = promisify(execFile)
function uncertainInput(error: unknown, operation: string): boolean {
  const message = error instanceof Error ? error.message : ''
  return !message.startsWith(`Native operation ${operation} failed: Native desktop test: `)
    || message.includes('input result uncertain') || message.includes('(timeout)')
}
/** Poll only while no confirmation has been dispatched; concurrent ticks share the same gate. */
export function nativeConfirmationPoll(operation: string, attempt: () => Promise<boolean>): () => Promise<void> {
  let busy = false, finished = false
  return async () => {
    if (busy || finished) return
    busy = true
    try { finished = await attempt() }
    catch (error) { if (uncertainInput(error, operation)) finished = true }
    finally { busy = false }
  }
}
/** An uncertain UI dispatch also disables later tray UI cleanup; owned process cleanup remains available. */
export function nativeActionSession(run: (operation: string, ...args: string[]) => Promise<unknown>) {
  let uncertain = false
  const action = async (operation: string, ...args: string[]): Promise<unknown> => {
    try { return await run(operation, ...args) }
    catch (error) { if (uncertainInput(error, operation)) uncertain = true; throw error }
  }
  return { action, cleanupTray: async (...args: string[]): Promise<boolean> => {
    if (uncertain) return false
    await action('tray-exit', ...args)
    return true
  } }
}
/** Retry only known pre-input refusals; timeouts and uncertain dispatch are never replayed. */
export async function confirmNativeProtocol(action: () => Promise<unknown>): Promise<void> {
  return confirmNativeAction('confirm-protocol', action)
}
/** Preserve native failure details for every retried confirmation, including GUI dialogs. */
export async function confirmNativeAction(operation: string, action: () => Promise<unknown>): Promise<void> {
  let failure: unknown = new Error('Native confirmation target unavailable')
  try {
    await eventually(async () => {
      try { await action(); return true }
      catch (error) {
        failure = error
        if (uncertainInput(error, operation)) throw error
        return false
      }
    }, 'native confirmation ' + operation)
  } catch { throw failure }
}
export interface NativeWindow { pid: number; started: string; visible: boolean; image: string; handle: string; owned: boolean }
export async function compileDesktopProbe(directory: string): Promise<string> {
  let framework = join(process.env.WINDIR ?? '', 'Microsoft.NET/Framework64/v4.0.30319')
  try { await access(join(framework,'csc.exe')) } catch { framework = join(process.env.WINDIR ?? '', 'Microsoft.NET/Framework/v4.0.30319') }
  const output = join(directory, 'desktop-probe.exe')
  await execute(join(framework, 'csc.exe'), ['/nologo', '/codepage:65001', '/target:exe', `/out:${output}`,
    '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(name => `/reference:${join(framework, 'WPF', name + '.dll')}`),
    join(import.meta.dirname, 'native/BrowserDesktopProbe.cs')], { windowsHide: true, timeout: 30000 })
  return output
}
export async function nativeProbe<T>(helper: string, operation: string, ...args: string[]): Promise<T> {
  let confirmation: ReturnType<typeof setInterval> | undefined
  try {
    const certificateOperation = operation === 'ca-add' || operation === 'ca-remove'
    const pending = execute(helper, [operation, ...args], { windowsHide: true, timeout: certificateOperation ? 45000 : 20000, maxBuffer: 1048576 })
    const identity = certificateOperation && pending.child.pid
      ? nativeProbe<{ pid: number; started: string; image: string }>(helper, 'identity', String(pending.child.pid)).catch(() => undefined)
      : Promise.resolve(undefined)
    if (certificateOperation) {
      const poll = nativeConfirmationPoll('confirm-ca', async () => {
        const target = await identity
        if (!target || pending.child.exitCode !== null || resolve(target.image).toLowerCase() !== resolve(helper).toLowerCase()) return false
        await nativeProbe(helper, 'confirm-ca', String(target.pid), target.started)
        return true
      })
      confirmation = setInterval(() => { if (pending.child.exitCode === null) void poll() }, 750)
    }
    const result = await pending
    return JSON.parse(result.stdout) as T
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : ''
    const reason = error && typeof error === 'object' && 'killed' in error && error.killed ? ' (timeout)' : ''
    throw new Error(`Native operation ${operation} failed${reason}${detail ? ': ' + detail : ''}`)
  } finally { clearInterval(confirmation) }
}
