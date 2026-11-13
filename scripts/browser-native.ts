/** Build and call the repository-owned Windows UIA test helper. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
const execute = promisify(execFile)
export interface NativeWindow { pid: number; started: string; visible: boolean; image: string; handle: string; owned: boolean }
export async function compileDesktopProbe(directory: string): Promise<string> {
  const framework = join(process.env.WINDIR ?? '', 'Microsoft.NET/Framework64/v4.0.30319')
  const output = join(directory, 'desktop-probe.exe')
  await execute(join(framework, 'csc.exe'), ['/nologo', '/target:exe', `/out:${output}`,
    '/reference:System.Web.Extensions.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(name => `/reference:${join(framework, 'WPF', name + '.dll')}`),
    join(import.meta.dirname, 'native/BrowserDesktopProbe.cs')], { windowsHide: true, timeout: 30000 })
  return output
}
export async function nativeProbe<T>(helper: string, operation: string, ...args: string[]): Promise<T> {
  try {
    const result = await execute(helper, [operation, ...args], { windowsHide: true, timeout: 20000, maxBuffer: 1048576 })
    return JSON.parse(result.stdout) as T
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : ''
    throw new Error(`Native operation ${operation} failed${detail ? ': ' + detail : ''}`)
  }
}
