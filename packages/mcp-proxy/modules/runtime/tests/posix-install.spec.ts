import { expect, it, onTestFinished } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { installPosixUri, uninstallPosixUri, type PosixInstallSpec } from '../src/posix-install.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-posix-uri-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const spec: PosixInstallSpec = { platform: 'linux', userHome: root, dataHome: join(root, 'data'),
    profileDir: join(root, 'profile'), home: join(root, 'dsh home'), profile: 'mcp-proxy',
    node: join(root, 'node'), cli: join(root, 'dsh.js'), settings: join(root, 'settings.json'),
  }
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const run = async (file: string, args: readonly string[]) => {
    calls.push({ file, args })
    return ''
  }
  return { root, spec, calls, run }
}

it('registers a Linux desktop URI handler with one URL argument and the fixed dsh profile', async () => {
  const { spec, calls, run } = await setup()
  const filename = await installPosixUri(spec, 5000, new AbortController().signal, run)
  const desktop = await readFile(filename, 'utf8')
  expect(desktop).toContain('MimeType=x-scheme-handler/mcp-proxy;')
  expect(desktop).toContain('Terminal=false')
  expect(desktop).toContain('--associate %u')
  expect(desktop).toContain('--profile "mcp-proxy"')
  expect(calls).toContainEqual({ file: 'xdg-mime', args: ['default', 'dsh-mcp-proxy.desktop', 'x-scheme-handler/mcp-proxy'] })
  await installPosixUri(spec, 5000, new AbortController().signal, run)
  await uninstallPosixUri(spec, 5000, new AbortController().signal, run)
  await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('uses POSIX locations when the launcher also supplies Windows registration metadata', async () => {
  const { spec, run } = await setup()
  const launcher = { ...spec, registryKey: 'Software\\Classes\\mcp-proxy' }
  const filename = await installPosixUri(launcher, 5000, new AbortController().signal, run)
  expect(await readFile(filename, 'utf8')).toContain('--associate %u')
})

it('refuses a foreign Linux launcher and preserves it on uninstall', async () => {
  const { spec, run } = await setup()
  await mkdir(join(spec.dataHome, 'applications'), { recursive: true })
  const filename = join(spec.dataHome, 'applications/dsh-mcp-proxy.desktop')
  await writeFile(filename, 'foreign')
  await expect(installPosixUri(spec, 5000, new AbortController().signal, run)).rejects.toThrow('owned')
  await uninstallPosixUri(spec, 5000, new AbortController().signal, run)
  expect(await readFile(filename, 'utf8')).toBe('foreign')
})

it('refuses another profile and a launcher changed after installation', async () => {
  const { root, spec, run } = await setup()
  const filename = await installPosixUri(spec, 5000, new AbortController().signal, run)
  await expect(installPosixUri({ ...spec, profileDir: join(root, 'other') }, 5000, new AbortController().signal, run)).rejects.toThrow('owned')
  await writeFile(filename, 'changed')
  await expect(uninstallPosixUri(spec, 5000, new AbortController().signal, run)).rejects.toThrow('changed')
  expect(await readFile(filename, 'utf8')).toBe('changed')
})

it('does not replace another Linux URL scheme handler', async () => {
  const { spec } = await setup()
  await expect(installPosixUri(spec, 5000, new AbortController().signal, async () => 'other.desktop\n'))
    .rejects.toThrow('another application')
})

it.each(['retry', 'uninstall'])('recovers an upgrade interrupted before launcher publication through %s', async (action) => {
  const { spec, run } = await setup()
  const filename = await installPosixUri(spec, 5000, new AbortController().signal, run)
  const receiptFile = join(spec.userHome, '.local/state/dsh-mcp-proxy/uri.json')
  const previous = JSON.parse(await readFile(receiptFile, 'utf8')) as Record<string, unknown>
  await writeFile(receiptFile, JSON.stringify({ ...previous, previousDigest: previous.digest,
    digest: createHash('sha256').update('unpublished successor').digest('hex'),
  }))
  if (action === 'retry') {
    await installPosixUri({ ...spec, settings: join(spec.userHome, 'next.json') }, 5000, new AbortController().signal, run)
    expect(await readFile(filename, 'utf8')).toContain('next.json')
  } else {
    await uninstallPosixUri(spec, 5000, new AbortController().signal, run)
    await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})
