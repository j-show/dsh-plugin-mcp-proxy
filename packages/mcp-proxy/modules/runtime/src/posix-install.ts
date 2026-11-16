/** Per-user POSIX URI installation for the local dsh profile. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Installation locations supplied by the owning launcher, never by an activation URL. */
export interface PosixInstallSpec {
  readonly platform: 'linux' | 'darwin'
  readonly userHome: string
  readonly dataHome: string
  readonly profileDir: string
  readonly home: string
  readonly profile: string
  readonly node: string
  readonly cli: string
  readonly settings: string
  readonly desktop?: boolean
}
type Run = (file: string, args: readonly string[]) => Promise<string>
const desktopId = 'dsh-mcp-proxy.desktop'
const scheme = 'x-scheme-handler/mcp-proxy'
interface Receipt { readonly version: 1; readonly owner: string; readonly digest: string; readonly previousDigest?: string }
/**
 * Register the owned Linux desktop protocol handler.
 * @param spec - trusted profile locations.
 * @param timeoutMs - OS command deadline.
 * @param signal - installer lifetime.
 * @param run - OS command owner.
 * @returns registered launcher.
 */
export async function installPosixUri(spec: PosixInstallSpec, timeoutMs: number, signal: AbortSignal, run?: Run): Promise<string> {
  const locations = validate(spec, timeoutMs)
  const execute = run ?? runner(timeoutMs, signal)
  signal.throwIfAborted()
  await privateDirectory(locations.directory)
  return withFileLock(locations.receipt, async () => {
    const previous = await receipt(locations.receipt, locations.owner)
    const existing = await contents(locations.launcher)
    if (existing !== undefined && (previous === undefined || !matches(existing, previous))) {
      throw new Error('Linux URI launcher is not owned or has changed')
    }
    const handler = (await execute('xdg-mime', ['query', 'default', scheme])).trim()
    if (handler !== '' && handler !== desktopId) throw new Error('The mcp-proxy URI scheme belongs to another application')
    const text = desktop(spec)
    signal.throwIfAborted()
    await mkdir(join(spec.dataHome, 'applications'), { recursive: true })
    // The receipt precedes publication so a failed registration can be resumed or removed.
    const next: Receipt = { version: 1, owner: locations.owner, digest: digest(text),
      ...(existing === undefined || digest(existing) === digest(text) ? {} : { previousDigest: digest(existing) }),
    }
    await writeFileAtomic(locations.receipt, JSON.stringify(next) + '\n', { mode: 0o600 })
    if (existing === undefined) await writeFile(locations.launcher, text, { flag: 'wx', mode: 0o600 })
    else await writeFileAtomic(locations.launcher, text, { mode: 0o600 })
    await execute('xdg-mime', ['default', desktopId, scheme])
    await writeFileAtomic(locations.receipt, JSON.stringify({ version: 1, owner: locations.owner, digest: next.digest }) + '\n', { mode: 0o600 })
    return locations.launcher
  }, { waitMs: timeoutMs })
}
/**
 * Remove only the recorded Linux protocol installation.
 * @param spec - trusted profile locations.
 * @param timeoutMs - OS command deadline.
 * @param signal - installer lifetime.
 * @param _run - reserved command owner for platform lifecycle operations.
 * @returns after removing the owned launcher.
 */
export async function uninstallPosixUri(spec: PosixInstallSpec, timeoutMs: number, signal: AbortSignal, _run?: Run): Promise<void> {
  const locations = validate(spec, timeoutMs)
  signal.throwIfAborted()
  if (await contents(locations.receipt) === undefined) return
  await privateDirectory(locations.directory)
  await withFileLock(locations.receipt, async () => {
    const previous = await receipt(locations.receipt, locations.owner)
    if (previous === undefined) return
    const existing = await contents(locations.launcher)
    if (existing !== undefined && !matches(existing, previous)) throw new Error('Linux URI launcher has changed')
    signal.throwIfAborted()
    if (existing !== undefined) await unlink(locations.launcher)
    await unlink(locations.receipt)
  }, { waitMs: timeoutMs })
}

function validate(spec: PosixInstallSpec, timeoutMs: number) {
  if (spec.platform !== 'linux') throw new Error('Unsupported POSIX URI installation platform')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid URI installation deadline')
  const paths = [spec.userHome, spec.dataHome, spec.profileDir, spec.home, spec.node, spec.cli, spec.settings]
  if (paths.some(value => !isAbsolute(value))) throw new Error('Invalid URI installation location')
  for (const value of [...paths, spec.profile]) {
    if (/[\x00-\x1f\x7f]/.test(value) || value.length === 0) {
      throw new Error('Invalid URI installation location')
    }
  }
  const directory = join(spec.userHome, '.local/state/dsh-mcp-proxy')
  return { directory, receipt: join(directory, 'uri.json'), launcher: join(spec.dataHome, 'applications', desktopId),
    owner: digest(JSON.stringify([spec.profileDir, spec.dataHome])),
  }
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32'
    && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw new Error('Private URI installation directory required')
}

async function contents(filename: string): Promise<string | undefined> {
  try {
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid URI installation file')
    return await readFile(filename, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function receipt(filename: string, owner: string): Promise<Receipt | undefined> {
  const text = await contents(filename)
  if (text === undefined) return undefined
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
    || !('owner' in value) || value.owner !== owner || !('digest' in value) || typeof value.digest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('URI registration is not owned by this profile')
  if ('previousDigest' in value && (typeof value.previousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.previousDigest))) {
    throw new Error('Invalid URI upgrade receipt')
  }
  return { version: 1, owner, digest: value.digest,
    ...('previousDigest' in value ? { previousDigest: value.previousDigest as string } : {}),
  }
}

function matches(text: string, value: Receipt): boolean {
  const hash = digest(text)
  return hash === value.digest || hash === value.previousDigest
}

function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }

function argument(value: string): string {
  const quoted = value.replace(/[%]/g, '%%').replace(/[\\"`$]/g, '\\$&')
  return '"' + quoted.replace(/\\/g, '\\\\') + '"'
}

function desktop(spec: PosixInstallSpec): string {
  const args = [argument('/usr/bin/env'), argument(`DSH_HOME=${spec.home}`), argument(spec.node),
    ...(spec.desktop ? ['--config', argument(spec.settings), '%u']
      : [argument(spec.cli), '--profile', argument(spec.profile), '--config', argument(spec.settings), '--associate', '%u'])]
  return `[Desktop Entry]\nType=Application\nName=mcp-proxy\nNoDisplay=true\nTerminal=false\nExec=${args.join(' ')}\nMimeType=${scheme};\n`
}

function runner(timeoutMs: number, signal: AbortSignal): Run {
  return async (file, args) => {
    try { return (await promisify(execFile)(file, [...args], { timeout: timeoutMs, signal, maxBuffer: 65536, windowsHide: true })).stdout }
    catch (_error) { throw new Error('URI registration command failed') }
  }
}
