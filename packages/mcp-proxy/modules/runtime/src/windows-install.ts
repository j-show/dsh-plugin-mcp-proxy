/** Owned per-user Windows URI registration for an existing dsh profile. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
/** Launcher locations supplied by the dsh profile, never by an activation URI. */
export interface WindowsInstallSpec {
  readonly profileDir: string
  readonly home: string
  readonly profile: string
  readonly node: string
  readonly cli: string
  readonly settings: string
  readonly registryKey: string
  /** Fixed installation runtime mode; never supplied by an activation URI. */
  readonly electronRunAsNode?: boolean
  /** Launch the persistent Electron GUI and return without waiting for it to exit. */
  readonly desktop?: boolean
  /** Preserve the installed desktop's app-data context when Windows launches the URI handler. */
  readonly localAppData?: string
}
/**
 * Publish and register the owned Windows protocol launcher.
 * @param spec - trusted profile installation locations.
 * @param helper - built GUI executable.
 * @param timeoutMs - OS deadline.
 * @param signal - installer lifetime.
 * @returns installed URI launcher.
 */
export async function installWindowsUri(spec: WindowsInstallSpec, helper: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const locations = validate(spec, timeoutMs)
  signal.throwIfAborted()
  await mkdir(locations.directory, { recursive: true })
  await assertDirectory(locations.directory)
  return withFileLock(locations.receipt, async () => {
    signal.throwIfAborted()
    let previous = await readReceipt(locations.receipt, locations.owner, spec.registryKey)
    if (previous?.phase === 'unregistered') {
      await removeRecordedFiles(locations.directory, locations.receipt, previous)
      previous = undefined
    }
    if (previous?.previousLauncher !== undefined) {
      await run(join(locations.directory, previous.currentHelper), '--register', timeoutMs, signal)
      previous = await retirePredecessor(locations.directory, locations.receipt, previous)
    }
    const bytes = await readFile(helper)
    const currentHelper = `mcp-proxy-${digest(bytes).slice(0, 12)}.exe`
    const filename = join(locations.directory, currentHelper)
    try { await writeFile(filename, bytes, { flag: 'wx' }) }
    catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      const entry = await lstat(filename)
      if (!entry.isFile() || entry.isSymbolicLink() || !(await readFile(filename)).equals(bytes)) {
        throw new Error('Existing mcp-proxy launcher differs from the installation artifact')
      }
    }
    const receipt: Receipt = { version: 1, owner: locations.owner, currentHelper, registryKey: spec.registryKey,
      ...(spec.electronRunAsNode === undefined ? {} : { electronRunAsNode: spec.electronRunAsNode }),
      ...(spec.desktop === undefined ? {} : { desktop: spec.desktop }),
      node: spec.node, home: spec.home, installTimeoutMs: timeoutMs,
      ...(spec.localAppData === undefined ? {} : { localAppData: spec.localAppData }),
      associateArgs: (spec.desktop ? ['--config', spec.settings] : [spec.cli, '--profile', spec.profile, '--config', spec.settings, '--associate'])
        .map(quote).join(' '),
      ...(previous === undefined ? {} : previous.currentHelper !== currentHelper
        ? { previousLauncher: previous.currentHelper }
        : previous.previousLauncher === undefined ? {} : { previousLauncher: previous.previousLauncher }),
    }
    signal.throwIfAborted()
    await writeFileAtomic(locations.receipt, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
    await run(filename, '--register', timeoutMs, signal)
    await retirePredecessor(locations.directory, locations.receipt, receipt)
    return filename
  }, { waitMs: timeoutMs })
}
/**
 * Unregister and remove only the recorded Windows protocol launcher.
 * @param spec - same profile installation locations.
 * @param timeoutMs - OS deadline.
 * @param signal - installer lifetime.
 * @returns after removing owned registration and launcher files.
 */
export async function uninstallWindowsUri(spec: WindowsInstallSpec, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const locations = validate(spec, timeoutMs)
  signal.throwIfAborted()
  try { await assertDirectory(locations.directory) }
  catch (error) { if (hasCode(error, 'ENOENT')) return; throw error }
  await withFileLock(locations.receipt, async () => {
    const receipt = await readReceipt(locations.receipt, locations.owner, spec.registryKey)
    if (receipt === undefined) return
    if (receipt.phase !== 'unregistered') {
      await run(join(locations.directory, receipt.currentHelper), '--unregister', timeoutMs, signal)
      await writeFileAtomic(locations.receipt, `${JSON.stringify({ ...receipt, phase: 'unregistered' })}\n`, { mode: 0o600 })
    }
    await removeRecordedFiles(locations.directory, locations.receipt, receipt)
  }, { waitMs: timeoutMs })
  try { await rmdir(locations.directory) }
  catch (error) { if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'ENOENT')) throw error }
}

interface Receipt {
  readonly localAppData?: string
  readonly electronRunAsNode?: boolean
  readonly desktop?: boolean
  readonly version: 1
  readonly phase?: 'unregistered'
  readonly owner: string
  readonly currentHelper: string
  readonly previousLauncher?: string
  readonly registryKey: string
  readonly node: string
  readonly home: string
  readonly associateArgs: string
  readonly installTimeoutMs: number
}
const helperName = /^mcp-proxy-[a-f0-9]{12}\.exe$/u
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
function validate(spec: WindowsInstallSpec, timeoutMs: number) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(spec.profile)
    || !/^Software\\[a-zA-Z0-9\\_-]+$/u.test(spec.registryKey)
    || ![spec.profileDir, spec.home, spec.node, spec.cli, spec.settings, ...(spec.localAppData === undefined ? [] : [spec.localAppData])]
      .every(value => isAbsolute(value) && !/["\x00-\x1f]/u.test(value))) {
    throw new Error('Invalid Windows mcp-proxy installation locations')
  }
  const directory = join(resolve(spec.profileDir), 'mcp-proxy-os')
  return { directory, receipt: join(directory, 'launcher.json'), owner: digest(resolve(spec.profileDir).toLowerCase()) }
}
function quote(value: string): string {
  if (/["\x00-\x1f]/u.test(value) || value.endsWith('\\')) throw new Error('Invalid Windows launcher argument')
  return `"${value}"`
}
async function assertDirectory(filename: string): Promise<void> {
  const entry = await lstat(filename)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('mcp-proxy installation directory must be a regular directory')
}
async function readReceipt(filename: string, owner: string, registryKey: string): Promise<Receipt | undefined> {
  let entry
  try { entry = await lstat(filename) }
  catch (error) { if (hasCode(error, 'ENOENT')) return; throw error }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 262144) throw new Error('Invalid mcp-proxy installation receipt')
  const value: unknown = JSON.parse(await readFile(filename, 'utf8'))
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
    || !('owner' in value) || value.owner !== owner || !('registryKey' in value) || value.registryKey !== registryKey
    || !('currentHelper' in value) || typeof value.currentHelper !== 'string' || !helperName.test(value.currentHelper)
    || ('phase' in value && value.phase !== 'unregistered')
    || ('previousLauncher' in value && (typeof value.previousLauncher !== 'string' || !helperName.test(value.previousLauncher)))) {
    throw new Error('mcp-proxy installation receipt belongs to another installation or is invalid')
  }
  // Only validated ownership and managed filenames are consumed from the durable receipt.
  return value as Receipt
}
async function run(filename: string, operation: '--register' | '--unregister', timeoutMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const entry = await lstat(filename)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Invalid installed mcp-proxy launcher')
  if (!filename.endsWith(`mcp-proxy-${digest(await readFile(filename)).slice(0, 12)}.exe`)) {
    throw new Error('Installed mcp-proxy launcher content differs from its receipt')
  }
  await promisify(execFile)(filename, [operation], { timeout: timeoutMs, signal, windowsHide: true })
}
async function retirePredecessor(directory: string, filename: string, receipt: Receipt): Promise<Receipt> {
  if (receipt.previousLauncher === undefined) return receipt
  if (receipt.previousLauncher !== receipt.currentHelper) {
    try { await unlink(join(directory, receipt.previousLauncher)) }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  }
  const { previousLauncher: _retired, ...current } = receipt
  await writeFileAtomic(filename, `${JSON.stringify(current)}\n`, { mode: 0o600 })
  return current
}
async function removeRecordedFiles(directory: string, filename: string, receipt: Receipt): Promise<void> {
  for (const name of new Set([receipt.currentHelper, receipt.previousLauncher])) {
    if (name === undefined) continue
    try { await unlink(join(directory, name)) }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error }
  }
  await unlink(filename)
}
