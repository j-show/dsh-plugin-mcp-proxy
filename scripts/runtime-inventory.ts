/** Immutable runtime qualification shared by packaging and native acceptance. */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export interface RuntimeInventory { version: 1; platform: string; arch: string; nodeVersion: string; files: Array<{ path: string; size: number; sha256: string }> }
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
async function files(root: string, directory = root): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error('Linked runtime content is not allowed')
    if (stat.isDirectory()) result.push(...await files(root, path))
    else if (stat.isFile()) result.push(relative(root,path).split(sep).join('/'))
    else throw new Error('Unsupported runtime content')
  }
  return result.filter(path => path !== 'mcp-runtime.json').sort()
}
export async function writeRuntimeInventory(resources: string, platform: string, arch: string, nodeVersion: string): Promise<string> {
  const rows: RuntimeInventory['files'] = []
  for (const path of await files(resources)) { const bytes = await readFile(join(resources,path)); rows.push({ path, size: bytes.length, sha256: digest(bytes) }) }
  const bytes = Buffer.from(JSON.stringify({ version: 1, platform, arch, nodeVersion, files: rows } satisfies RuntimeInventory) + '\n')
  await writeFile(join(resources,'mcp-runtime.json'), bytes, { flag: 'wx' })
  return digest(bytes)
}
export async function verifyDesktopRuntime(distribution: string): Promise<void> {
  const resources = join(distribution,'resources')
  if ((await lstat(resources)).isSymbolicLink()) throw new Error('Linked runtime directory')
  const value = JSON.parse(await readFile(join(resources,'mcp-runtime.json'),'utf8')) as RuntimeInventory
  if (value.version !== 1 || !Array.isArray(value.files) || !value.nodeVersion.startsWith('22.')) throw new Error('Invalid runtime inventory')
  const actual = await files(resources)
  if (JSON.stringify(actual) !== JSON.stringify(value.files.map(row => row.path))) throw new Error('Runtime inventory file set changed')
  for (const row of value.files) {
    if (row.path.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))) throw new Error('Invalid runtime inventory path')
    const bytes = await readFile(join(resources,row.path))
    if (bytes.length !== row.size || digest(bytes) !== row.sha256) throw new Error('Runtime inventory hash mismatch')
  }
}
