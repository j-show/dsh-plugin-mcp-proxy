/** Verified persistent runtime publication for the Electron portable bootstrap. */
import * as filesystem from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

const manifestPath = 'resources/mcp-runtime.json'
/** Raw operations; Electron supplies original-fs to keep ASAR an ordinary file. */
export type RuntimeFilesystem = typeof filesystem
/** Build-owned runtime file record. */
export interface RuntimeFile { readonly path: string; readonly sha256: string }
/** Electron distribution metadata, excluding the manifest's own bytes. */
export interface RuntimeManifest { readonly format: 1; readonly executable: 'mcp-proxy.exe'; readonly files: readonly RuntimeFile[] }
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function member(value: unknown): value is string {
  return typeof value === 'string' && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'
    && !/[\\:\x00-\x1f<>"|?*]/u.test(part) && !/[. ]$/u.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}

/** @param bytes - serialized build metadata. @returns validated runtime members. */
export function parseRuntimeManifest(bytes: Uint8Array): RuntimeManifest {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
  if (typeof value !== 'object' || value === null || !('format' in value) || value.format !== 1
    || !('executable' in value) || value.executable !== 'mcp-proxy.exe' || !('files' in value) || !Array.isArray(value.files)
    || value.files.length === 0) throw new Error('Invalid Electron runtime manifest')
  const seen = new Set<string>()
  for (const file of value.files as unknown[]) {
    if (typeof file !== 'object' || file === null || !('path' in file) || !member(file.path)
      || file.path.toLowerCase() === manifestPath || seen.has(file.path.toLowerCase())
      || !('sha256' in file) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Invalid Electron runtime member')
    }
    seen.add(file.path.toLowerCase())
  }
  if (!seen.has(value.executable)) throw new Error('Electron runtime executable missing')
  return value as RuntimeManifest
}

async function directory(path: string, fs: RuntimeFilesystem): Promise<void> {
  const stat = await fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Electron runtime directory is not a regular directory')
}

async function filesUnder(root: string, fs: RuntimeFilesystem, relative = ''): Promise<string[]> {
  await directory(join(root, relative), fs)
  const found: string[] = []
  for (const entry of await fs.readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    const stat = await fs.lstat(join(root, path))
    if (stat.isSymbolicLink()) throw new Error('Electron runtime links are forbidden')
    if (stat.isDirectory()) found.push(...await filesUnder(root, fs, path))
    else if (stat.isFile()) found.push(path)
    else throw new Error('Unsupported Electron runtime file')
  }
  return found
}

async function verify(root: string, manifest: RuntimeManifest, bytes: Uint8Array, fs: RuntimeFilesystem): Promise<void> {
  const actual = (await filesUnder(root, fs)).filter(path => path !== manifestPath).sort()
  const expected = manifest.files.map(file => file.path).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const extra = actual.filter(path => !expected.includes(path)).slice(0, 4)
    const missing = expected.filter(path => !actual.includes(path)).slice(0, 4)
    throw new Error(`Electron runtime file inventory differs (${JSON.stringify({ extra, missing })})`)
  }
  if (!Buffer.from(await fs.readFile(join(root, manifestPath))).equals(bytes)) throw new Error('Electron runtime manifest differs')
  for (const file of manifest.files) {
    if (digest(await fs.readFile(join(root, file.path))) !== file.sha256) throw new Error('Electron runtime content differs')
  }
}

/** Read-only qualification used before artifact acceptance; does not publish or alter a cache. */
export async function verifyElectronRuntime(root: string): Promise<void> {
  await directory(root, filesystem)
  const metadata = join(root, manifestPath)
  const stat = await filesystem.lstat(metadata)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16777216) throw new Error('Invalid Electron runtime manifest file')
  const bytes = await filesystem.readFile(metadata)
  await verify(root, parseRuntimeManifest(bytes), bytes, filesystem)
}

/**
 * @param root - final unpacked Electron distribution, after binary editing/signing.
 * @returns after writing its immutable file inventory for portable packaging.
 */
export async function writeElectronRuntimeManifest(root: string): Promise<void> {
  const paths = (await filesUnder(root, filesystem)).filter(path => path !== manifestPath).sort()
  const files: RuntimeFile[] = []
  for (const path of paths) files.push({ path, sha256: digest(await filesystem.readFile(join(root, path))) })
  const bytes = Buffer.from(JSON.stringify({ format: 1, executable: 'mcp-proxy.exe', files }))
  parseRuntimeManifest(bytes)
  await filesystem.writeFile(join(root, manifestPath), bytes, { flag: 'wx' })
}

async function removeStaging(path: string, fs: RuntimeFilesystem): Promise<void> {
  const stat = await fs.lstat(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) { await fs.unlink(path); return }
  for (const entry of await fs.readdir(path)) await removeStaging(join(path, entry), fs)
  await fs.rmdir(path)
}

/**
 * @param source - complete temporarily extracted Electron distribution.
 * @param cacheRoot - application-owned per-user runtime cache.
 * @param fs - raw operations without ASAR virtualization.
 * @returns validated persistent runtime; damaged existing versions are retained and rejected.
 */
export async function prepareElectronRuntime(source: string, cacheRoot: string, fs: RuntimeFilesystem = filesystem): Promise<string> {
  await directory(source, fs)
  const metadata = join(source, manifestPath)
  const stat = await fs.lstat(metadata)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16777216) throw new Error('Invalid Electron runtime manifest file')
  const bytes = await fs.readFile(metadata)
  const manifest = parseRuntimeManifest(bytes)
  await fs.mkdir(cacheRoot, { recursive: true })
  await directory(cacheRoot, fs)
  const destination = join(cacheRoot, digest(bytes))
  let existing = false
  try { await fs.lstat(destination); existing = true } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  if (existing) { await verify(destination, manifest, bytes, fs); return destination }
  await verify(source, manifest, bytes, fs)
  const staging = await fs.mkdtemp(join(cacheRoot, '.staging-'))
  try {
    for (const path of [...manifest.files.map(file => file.path), manifestPath]) {
      const target = join(staging, path)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.writeFile(target, await fs.readFile(join(source, path)), { flag: 'wx' })
    }
    await verify(staging, manifest, bytes, fs)
    try { await fs.rename(staging, destination) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code))) throw error
      await verify(destination, manifest, bytes, fs)
    }
  } finally {
    try { await removeStaging(staging, fs) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
  return destination
}
