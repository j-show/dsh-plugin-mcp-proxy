/** Build-only Windows GUI bridge compilation; supported service launches still use dsh profiles. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Compile the product's GUI URI entry using the platform .NET Framework compiler.
 * @param destination - owned artifact directory.
 * @param timeoutMs - bounded compiler deadline.
 * @returns compiled executable filename; no registration or launch is performed.
 */
export async function compileWindowsUriHelper(destination: string, timeoutMs: number): Promise<string> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new Error('Invalid Windows URI helper build request')
  }
  const windows = process.env['WINDIR']
  if (windows === undefined) throw new Error('Windows compiler location unavailable')
  await mkdir(destination, { recursive: true })
  const filename = join(destination, 'mcp-proxy.exe')
  const source = fileURLToPath(new URL('../native/windows/UriLauncher.cs', import.meta.url))
  try {
    await promisify(execFile)(join(windows, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
      '/nologo', '/target:winexe', '/reference:System.Runtime.Serialization.dll', `/out:${filename}`, source,
    ], { timeout: timeoutMs, windowsHide: true })
    return filename
  } catch (_error) { throw new Error('Windows mcp-proxy URI helper build failed') }
}
