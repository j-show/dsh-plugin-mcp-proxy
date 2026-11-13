/** macOS URI application installation for an existing dsh profile. */
import type { PosixInstallSpec } from './posix-install.ts'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

type Spec = Omit<PosixInstallSpec, 'platform' | 'dataHome'>
type Run = (file: string, args: readonly string[]) => Promise<string>
type Files = Record<string, string | null>
interface Receipt {
  readonly version: 1
  readonly owner: string
  readonly recipe: string
  readonly files: Files
  readonly removing: boolean
}
const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
/**
 * Register the owned macOS application protocol handler.
 * @param spec - trusted profile locations.
 * @param timeoutMs - command deadline.
 * @param signal - installation lifetime.
 * @param run - command owner.
 * @returns installed app; changed launcher locations require uninstalling the existing registration first.
 */
export async function installMacosUri(spec: Spec, timeoutMs: number, signal: AbortSignal, run?: Run): Promise<string> {
  const locations = validate(spec, timeoutMs)
  const execute = run ?? runner(timeoutMs, signal)
  await privateDirectory(locations.directory)
  return withFileLock(locations.receipt, async () => {
    signal.throwIfAborted()
    let previous = await receipt(locations.receipt, locations.owner)
    if (previous?.removing) {
      await removeApp(locations.app, previous)
      await unlink(locations.receipt)
      previous = undefined
    }
    const script = appleScript(spec)
    const recipe = hash(script)
    const existing = await tree(locations.app)
    const handler = await defaultHandler(execute)
    if (handler !== undefined && normalize(handler) !== normalize(locations.app)) {
      throw new Error('The mcp-proxy URI scheme belongs to another application')
    }
    if (previous !== undefined && previous.recipe !== recipe) throw new Error('Uninstall the existing macOS URI launcher before changing its locations')
    if (existing !== undefined) {
      if (previous === undefined) throw new Error('macOS URI application is not owned by this profile')
      verify(existing, previous.files, false)
    } else {
      const stage = await mkdtemp(join(locations.directory, 'build-'))
      try {
        const app = join(stage, 'mcp-proxy.app')
        await execute('/usr/bin/osacompile', ['-o', app, '-e', script])
        const plist = join(app, 'Contents/Info.plist')
        const edits = [
          'Add :LSUIElement bool true',
          'Add :CFBundleURLTypes array',
          'Add :CFBundleURLTypes:0 dict',
          'Add :CFBundleURLTypes:0:CFBundleTypeRole string Viewer',
          'Add :CFBundleURLTypes:0:CFBundleURLName string ai.deepseek.dsh.mcp-proxy',
          'Add :CFBundleURLTypes:0:CFBundleURLSchemes array',
          'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string mcp-proxy',
        ]
        await execute('/usr/bin/defaults', ['write', plist, 'CFBundleIdentifier', '-string', 'ai.deepseek.dsh.mcp-proxy'])
        for (const edit of edits) await execute('/usr/libexec/PlistBuddy', ['-c', edit, plist])
        await execute('/usr/bin/codesign', ['--force', '--sign', '-', app])
        const files = await tree(app)
        if (files === undefined || files['Contents/MacOS/applet'] === undefined || files['Contents/Info.plist'] === undefined) {
          throw new Error('macOS URI compilation produced no application')
        }
        signal.throwIfAborted()
        await mkdir(join(spec.userHome, 'Applications'), { recursive: true })
        await writeFileAtomic(locations.receipt, JSON.stringify({ version: 1, owner: locations.owner, recipe, files, removing: false }) + '\n', { mode: 0o600 })
        await rename(app, locations.app)
      } finally {
        const child = relative(locations.directory, stage)
        if (child.startsWith('build-') && !child.includes(sep)) await rm(stage, { recursive: true, force: true })
      }
    }
    await execute(register, ['-f', locations.app])
    const selected = await defaultHandler(execute)
    if (selected === undefined || normalize(selected) !== normalize(locations.app)) {
      throw new Error('The installed macOS URI application is not selected by the operating system')
    }
    return locations.app
  }, { waitMs: timeoutMs })
}
/**
 * Remove only the recorded macOS protocol installation.
 * @param spec - trusted profile locations.
 * @param timeoutMs - command deadline.
 * @param signal - installation lifetime.
 * @param run - command owner.
 * @returns after removing recorded, unchanged application files.
 */
export async function uninstallMacosUri(spec: Spec, timeoutMs: number, signal: AbortSignal, run?: Run): Promise<void> {
  const locations = validate(spec, timeoutMs)
  signal.throwIfAborted()
  if (await optionalStat(locations.receipt) === undefined) return
  const execute = run ?? runner(timeoutMs, signal)
  await privateDirectory(locations.directory)
  await withFileLock(locations.receipt, async () => {
    const previous = await receipt(locations.receipt, locations.owner)
    if (previous === undefined) return
    const existing = await tree(locations.app)
    if (existing !== undefined) verify(existing, previous.files, previous.removing)
    if (!previous.removing) {
      if (existing !== undefined) await execute(register, ['-u', locations.app])
      await writeFileAtomic(locations.receipt, JSON.stringify({ ...previous, removing: true }) + '\n', { mode: 0o600 })
    }
    signal.throwIfAborted()
    await removeApp(locations.app, previous)
    await unlink(locations.receipt)
  }, { waitMs: timeoutMs })
}

function validate(spec: Spec, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid URI installation deadline')
  const paths = [spec.userHome, spec.profileDir, spec.home, spec.node, spec.cli, spec.settings]
  if (paths.some(value => !isAbsolute(value)) || [...paths, spec.profile].some(value => !value || /[\x00-\x1f\x7f]/.test(value))) {
    throw new Error('Invalid URI installation location')
  }
  const directory = join(spec.userHome, 'Library/Application Support/dsh-mcp-proxy')
  return { directory, receipt: join(directory, 'uri.json'), app: join(spec.userHome, 'Applications/mcp-proxy.app'), owner: hash(spec.profileDir) }
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32'
    && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw new Error('Private URI installation directory required')
}

async function optionalStat(filename: string) {
  try { return await lstat(filename) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function tree(root: string): Promise<Files | undefined> {
  const stat = await optionalStat(root)
  if (stat === undefined) return undefined
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('macOS URI application has changed')
  const entries: Array<[string, string | null]> = []
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const entry = await lstat(path)
      if (entry.isSymbolicLink()) throw new Error('macOS URI application has changed')
      const key = relative(root, path).split(sep).join('/')
      if (entry.isDirectory()) { entries.push([key, null]); await visit(path) }
      else if (entry.isFile()) entries.push([key, hash(await readFile(path))])
      else throw new Error('macOS URI application has changed')
    }
  }
  await visit(root)
  return Object.fromEntries(entries)
}

async function receipt(filename: string, owner: string): Promise<Receipt | undefined> {
  const stat = await optionalStat(filename)
  if (stat === undefined) return undefined
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid macOS URI receipt')
  const value: unknown = JSON.parse(await readFile(filename, 'utf8'))
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
    || !('owner' in value) || value.owner !== owner || !('recipe' in value) || typeof value.recipe !== 'string'
    || !('removing' in value) || typeof value.removing !== 'boolean' || !('files' in value)
    || typeof value.files !== 'object' || value.files === null || Array.isArray(value.files)) throw new Error('macOS URI application is not owned by this profile')
  for (const [path, hash] of Object.entries(value.files)) {
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:\x00-\x1f]/.test(path)
      || (hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) throw new Error('Invalid macOS URI file record')
  }
  return { version: 1, owner, recipe: value.recipe, files: value.files as Files, removing: value.removing }
}

function verify(actual: Files, recorded: Files, missingAllowed: boolean): void {
  if (Object.entries(actual).some(([key, value]) => !Object.hasOwn(recorded, key) || recorded[key] !== value)
    || (!missingAllowed && Object.keys(recorded).length !== Object.keys(actual).length)) throw new Error('macOS URI application has changed')
}

async function removeApp(app: string, recorded: Receipt): Promise<void> {
  const files = await tree(app)
  if (files === undefined) return
  verify(files, recorded.files, true)
  for (const [path, digest] of Object.entries(files)) if (digest !== null) await unlink(join(app, path))
  const directories = Object.entries(files).filter(([, value]) => value === null).map(([path]) => path).sort((a, b) => b.length - a.length)
  for (const directory of directories) await rmdir(join(app, directory))
  await rmdir(app)
}

function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

async function defaultHandler(run: Run): Promise<string | undefined> {
  const script = 'use framework "AppKit"\nuse scripting additions\n'
    + 'set targetURL to current application\'s NSURL\'s URLWithString:"mcp-proxy://associate/"\n'
    + 'set targetApp to current application\'s NSWorkspace\'s sharedWorkspace()\'s URLForApplicationToOpenURL:targetURL\n'
    + 'if targetApp is missing value then return ""\nreturn targetApp\'s |path|() as text'
  const result = (await run('/usr/bin/osascript', ['-e', script])).trim()
  if (!result) return undefined
  if (!isAbsolute(result) || /[\x00-\x1f\x7f]/.test(result)) throw new Error('Invalid macOS URI application response')
  return result
}

function appleScript(spec: Spec): string {
  const quote = (text: string): string => "'" + text.replace(/'/g, "'\\''") + "'"
  const command = ['/usr/bin/env', `DSH_HOME=${spec.home}`, spec.node, spec.cli,
    '--profile', spec.profile, '--config', spec.settings, '--associate'].map(quote).join(' ') + ' '
  const literal = '"' + command.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  return `on open location incomingUrl\ntry\ndo shell script (${literal} & quoted form of incomingUrl)\nend try\nend open location\n`
}

function runner(timeoutMs: number, signal: AbortSignal): Run {
  return async (file, args) => {
    try { return (await promisify(execFile)(file, [...args], { timeout: timeoutMs, signal, maxBuffer: 65536, windowsHide: true })).stdout }
    catch (_error) { throw new Error('macOS URI registration command failed') }
  }
}
