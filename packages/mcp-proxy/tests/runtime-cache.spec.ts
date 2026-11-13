import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { prepareElectronRuntime } from '../src/runtime-cache.ts'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp electron cache '))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'portable')
  const cache = join(root, 'cache')
  await mkdir(join(source, 'resources/dsh/lib'), { recursive: true })
  const files = { 'mcp-proxy.exe': 'electron fixture', 'resources/dsh/lib/bin.js': 'dsh fixture' }
  for (const [path, content] of Object.entries(files)) await writeFile(join(source, path), content)
  const manifest = JSON.stringify({ format: 1, executable: 'mcp-proxy.exe',
    files: Object.entries(files).map(([path, content]) => ({ path, sha256: digest(content) })),
  })
  await writeFile(join(source, 'resources/mcp-runtime.json'), manifest)
  return { root, source, cache, manifest, files }
}

it('publishes a complete runtime outside the temporary portable directory and reuses the same version', async () => {
  const f = await fixture()
  const installed = await prepareElectronRuntime(f.source, f.cache)
  expect(installed).toBe(join(f.cache, digest(f.manifest)))
  for (const [path, content] of Object.entries(f.files)) expect(await readFile(join(installed, path), 'utf8')).toBe(content)
  expect(await prepareElectronRuntime(f.source, f.cache)).toBe(installed)
})

it('lets concurrent cold launches publish one complete cache without stale writer locks', async () => {
  const f = await fixture()
  const roots = await Promise.all([prepareElectronRuntime(f.source, f.cache), prepareElectronRuntime(f.source, f.cache)])
  expect(roots[0]).toBe(roots[1])
  expect(await readdir(f.cache)).toEqual([digest(f.manifest)])
})

it('rejects a changed cached file without deleting or executing that runtime', async () => {
  const f = await fixture()
  const installed = await prepareElectronRuntime(f.source, f.cache)
  await writeFile(join(installed, 'mcp-proxy.exe'), 'damaged')
  await expect(prepareElectronRuntime(f.source, f.cache)).rejects.toThrow('runtime')
  expect(await readFile(join(installed, 'mcp-proxy.exe'), 'utf8')).toBe('damaged')
})

it.each(['../escape.exe', '/absolute.exe', 'C:/escape.exe', 'resources\\escape.exe', 'file:stream', 'trailing.'])(
  'rejects the manifest member %s before publishing a runtime', async (path) => {
    const f = await fixture()
    await writeFile(join(f.source, 'resources/mcp-runtime.json'), JSON.stringify({ format: 1, executable: 'mcp-proxy.exe',
      files: [{ path, sha256: digest('fixture') }],
    }))
    await expect(prepareElectronRuntime(f.source, f.cache)).rejects.toThrow('runtime')
    await expect(readFile(join(f.root, 'escape.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

it('refuses an unlisted runtime file and leaves the existing cache intact', async () => {
  const f = await fixture()
  const installed = await prepareElectronRuntime(f.source, f.cache)
  await writeFile(join(installed, 'unexpected.dll'), 'unlisted')
  await expect(prepareElectronRuntime(f.source, f.cache)).rejects.toThrow('runtime')
  expect(await readFile(join(installed, 'unexpected.dll'), 'utf8')).toBe('unlisted')
})
