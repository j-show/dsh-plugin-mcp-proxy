/** Exact-build native acceptance inputs; no directory discovery or latest-file heuristics. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export interface ProductBuild {
  readonly version: 1
  readonly buildId: string
  readonly executable: string
  readonly publishedExecutable: string
  readonly runtime: string
  readonly executableSha256: string
  readonly manifestSha256: string
}
const receipt = 'release/mcp-proxy/product-build.json'
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function safePath(root: string, value: string): Promise<string> {
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))) throw new Error('Invalid product build path')
  let result = resolve(root)
  for (const part of parts) {
    result = join(result, part)
    if ((await lstat(result)).isSymbolicLink()) throw new Error('Linked product build path is not allowed')
  }
  return result
}

/** Publish only after the portable EXE and qualified unpacked distribution both completed. */
export async function writeProductBuild(root: string, executable: string, runtime: string, builtExecutable = join(dirname(runtime), 'mcp-proxy.exe')): Promise<void> {
  const exe = relative(root, executable).split(sep).join('/')
  const distribution = relative(root, runtime).split(sep).join('/')
  if (exe !== 'release/mcp-proxy/mcp-proxy.exe' || !/^\.artifacts\/build-proxy-[A-Za-z0-9_-]+\/electron\/distribution\/win-unpacked$/.test(distribution)) throw new Error('Invalid product build path')
  const uniqueExe = relative(root, builtExecutable).split(sep).join('/')
  if (uniqueExe !== distribution.replace(/\/win-unpacked$/, '/mcp-proxy.exe')) throw new Error('Invalid unique product build path')
  const record: ProductBuild = { version: 1, buildId: distribution.split('/')[1]!, executable: uniqueExe, publishedExecutable: exe, runtime: distribution,
    executableSha256: digest(await readFile(await safePath(root, relative(root, builtExecutable).split(sep).join('/')))),
    manifestSha256: digest(await readFile(await safePath(root, distribution + '/resources/mcp-runtime.json'))) }
  const pending = join(root, receipt + '.' + randomUUID() + '.pending')
  await writeFile(pending, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  await rename(pending, join(root, receipt))
}

/** Resolve the recorded pair and reject stale/mixed artifacts before executing any EXE. */
export async function readProductBuild(root: string): Promise<ProductBuild & { executable: string; runtime: string }> {
  let value: unknown
  try { value = JSON.parse(await readFile(await safePath(root, receipt), 'utf8')) } catch (error) {
    throw new Error('Cannot read product build record; run pnpm build:mcp-proxy.', { cause: error })
  }
  if (typeof value !== 'object' || value === null) throw new Error('Invalid product build record')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.buildId !== 'string' || !/^build-proxy-[A-Za-z0-9_-]+$/.test(record.buildId)
    || record.publishedExecutable !== 'release/mcp-proxy/mcp-proxy.exe'
    || record.executable !== `.artifacts/${record.buildId}/electron/distribution/mcp-proxy.exe`
    || record.runtime !== `.artifacts/${record.buildId}/electron/distribution/win-unpacked`
    || typeof record.executableSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.executableSha256)
    || typeof record.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.manifestSha256)) throw new Error('Invalid product build record path or hash')
  const executable = await safePath(root, record.executable as string)
  const published = await safePath(root, record.publishedExecutable)
  const runtime = await safePath(root, record.runtime as string)
  const manifest = await safePath(root, (record.runtime as string) + '/resources/mcp-runtime.json')
  if (digest(await readFile(executable)) !== record.executableSha256 || digest(await readFile(published)) !== record.executableSha256 || digest(await readFile(manifest)) !== record.manifestSha256) throw new Error('Product build hash mismatch; rebuild both artifacts together')
  return { ...(record as unknown as ProductBuild), executable, runtime }
}
