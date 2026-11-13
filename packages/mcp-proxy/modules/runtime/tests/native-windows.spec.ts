import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { compileWindowsUriHelper } from '../src/native-builder.ts'
import { installWindowsUri, uninstallWindowsUri } from '../src/windows-install.ts'

it.skipIf(process.platform !== 'win32').each([
  { electronRunAsNode: false, pairing: false }, { electronRunAsNode: true, pairing: false }, { electronRunAsNode: true, pairing: true },
])('launches fixed profile arguments through a GUI executable, mode=%o',
  { timeout: 15000 }, async ({ electronRunAsNode, pairing }) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp proxy & native-'))
    const spec = { profileDir: root, home: root, profile: 'mcp-proxy', node: process.execPath,
      cli: join(root, 'dsh fixture.mjs'), settings: join(root, 'received.json'), electronRunAsNode,
      registryKey: `Software\\mcp-proxy-test-${randomUUID()}`, localAppData: join(root, 'isolated-data'),
    }
    onTestFinished(async () => {
      try { await uninstallWindowsUri(spec, 5000, new AbortController().signal) }
      finally { await rm(root, { recursive: true, force: true }) }
    })
    const helper = await compileWindowsUriHelper(join(root, 'build'), 10000)
    const entry = join(root, 'dsh fixture.mjs')
    const output = join(root, 'received.json')
    await writeFile(entry, "import { writeFile } from 'node:fs/promises'; const args = process.argv.slice(2); await writeFile(args[args.indexOf('--config') + 1], JSON.stringify({ args, home: process.env.DSH_HOME, localAppData: process.env.LOCALAPPDATA, nodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null }));\n")
    const executable = await installWindowsUri(spec, helper, 5000, new AbortController().signal)
    const uri = `mcp-proxy://associate/${'a'.repeat(43)}` + (pairing ? '?v=2&origin=https%3A%2F%2Fdsh.example' : '')
    await promisify(execFile)(executable, [uri], { timeout: 5000, windowsHide: true })
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(output, 'utf8')) as unknown } catch (_error) { return undefined }
    }).toEqual({ args: ['--profile', 'mcp-proxy', '--config', output, '--associate', uri], home: root,
      nodeMode: electronRunAsNode ? '1' : null, localAppData: spec.localAppData,
    })
    const events = await readFile(join(dirname(executable), basename(executable, '.exe') + '.activation.log'), 'utf8')
    expect(events).toContain('activation-received')
    expect(events).toContain('child-spawned')
    expect(events).not.toContain('a'.repeat(43))
  })

it.skipIf(process.platform !== 'win32').each(['native', 'short'] as const)('installs and upgrades an owned launcher through %s paths', { timeout: 20000 }, async (mode, context) => {
  const created = await mkdtemp(join(tmpdir(), 'mcp-proxy-install-long-directory-'))
  onTestFinished(() => rm(created, { recursive: true, force: true }))
  const canonical = await realpath(created)
  const code = "Add-Type -TypeDefinition 'using System.Text; using System.Runtime.InteropServices; public static class ShortPath { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode)] public static extern uint GetShortPathName(string p, StringBuilder b, int n); }'; $b = [Text.StringBuilder]::new(32768); if ([ShortPath]::GetShortPathName($env:MCP_PROXY_TEST_LONG_PATH,$b,$b.Capacity) -eq 0) { exit 1 }; [Console]::Write($b.ToString())"
  const short = mode === 'short' ? (await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code],
    { env: { ...process.env, MCP_PROXY_TEST_LONG_PATH: canonical }, windowsHide: true })).stdout.trim() : canonical
  if (mode === 'short' && short === canonical) { context.skip(); return } // Volume has 8.3 aliases disabled.
  const root = mode === 'short' ? short : created
  const helper = await compileWindowsUriHelper(join(root, 'build'), 10000)
  const spec = { profileDir: root, home: root, profile: 'mcp-proxy', node: process.execPath,
    cli: join(root, 'dsh.js'), settings: join(root, 'settings.json'), registryKey: `Software\\mcp-proxy-test-${randomUUID()}`,
  }
  onTestFinished(async () => {
    try { await uninstallWindowsUri(spec, 5000, new AbortController().signal) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const filename = await installWindowsUri(spec, helper, 5000, new AbortController().signal)
  expect(await readFile(filename)).toEqual(await readFile(helper))
  const activationPath = mode === 'short' ? (await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code],
    { env: { ...process.env, MCP_PROXY_TEST_LONG_PATH: filename }, windowsHide: true })).stdout.trim() : filename
  await expect(promisify(execFile)(activationPath, [`mcp-proxy://associate/${'b'.repeat(42)}`],
    { timeout: 5000, windowsHide: true })).rejects.toMatchObject({ code: 1 })
  const trace = await readFile(join(dirname(filename), basename(filename, '.exe') + '.activation.log'), 'utf8')
  expect(trace).toContain('uri-path-length-invalid')
  expect(trace).toContain('activation-invalid')
  expect(trace).not.toContain('b'.repeat(42))
  const replacement = Buffer.concat([await readFile(helper), Buffer.from('updated-build')])
  await writeFile(helper, replacement)
  const nextName = `mcp-proxy-${createHash('sha256').update(replacement).digest('hex').slice(0, 12)}.exe`
  const receiptFile = join(root, 'mcp-proxy-os', 'launcher.json')
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as Record<string, unknown>
  // A crash after committing metadata leaves the registered command on the predecessor.
  await writeFile(join(root, 'mcp-proxy-os', nextName), replacement)
  await writeFile(receiptFile, JSON.stringify({ ...receipt, currentHelper: nextName, previousLauncher: filename.split(/[\\/]/u).at(-1) }))
  const successor = await installWindowsUri(spec, helper, 5000, new AbortController().signal)
  expect(successor).toBe(join(root, 'mcp-proxy-os', nextName))
  expect(await installWindowsUri(spec, helper, 5000, new AbortController().signal)).toBe(successor)
  // A crash between predecessor deletion and receipt publication must remain recoverable.
  const retiredReceipt = JSON.parse(await readFile(receiptFile, 'utf8')) as Record<string, unknown>
  await writeFile(receiptFile, JSON.stringify({ ...retiredReceipt, previousLauncher: basename(filename) }))
  expect(await installWindowsUri(spec, helper, 5000, new AbortController().signal)).toBe(successor)
  const userFile = join(root, 'mcp-proxy-os', 'keep-user.txt')
  await writeFile(userFile, 'keep')
  await uninstallWindowsUri(spec, 5000, new AbortController().signal)
  expect(await readFile(userFile, 'utf8')).toBe('keep')
  await expect(readFile(filename)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(successor)).rejects.toMatchObject({ code: 'ENOENT' })
  const installed = await installWindowsUri(spec, helper, 5000, new AbortController().signal)
  await promisify(execFile)(installed, ['--unregister'], { timeout: 5000, windowsHide: true })
  const removal = JSON.parse(await readFile(receiptFile, 'utf8')) as Record<string, unknown>
  await writeFile(receiptFile, JSON.stringify({ ...removal, phase: 'unregistered' }))
  await unlink(installed)
  await uninstallWindowsUri(spec, 5000, new AbortController().signal)
  await expect(readFile(receiptFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform !== 'win32')('registers and removes only its owned URI key in an isolated registry namespace',
  { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-proxy-registry-'))
    const executable = await compileWindowsUriHelper(root, 10000)
    const owner = 'a'.repeat(64)
    const metadata = { node: process.execPath, associateArgs: '--version', home: root,
      registryKey: `Software\\mcp-proxy-test-${randomUUID()}`, owner, installTimeoutMs: 5000,
    }
    const save = async (value: string) => writeFile(join(root, 'launcher.json'), JSON.stringify({ ...metadata, owner: value }))
    onTestFinished(async () => {
      try {
        await save(owner)
        await promisify(execFile)(executable, ['--unregister'], { timeout: 5000, windowsHide: true })
      } finally { await rm(root, { recursive: true, force: true }) }
    })
    await save(owner)
    await promisify(execFile)(executable, ['--register'], { timeout: 5000, windowsHide: true })
    const commandKey = `HKCU\\${metadata.registryKey}\\shell\\open\\command`
    const setCommand = (value: string) => promisify(execFile)('reg.exe', ['add', commandKey, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true })
    try {
      await setCommand('"C:\\unrelated.exe" "%1"')
      await expect(promisify(execFile)(executable, ['--register'], { timeout: 5000, windowsHide: true })).rejects.toMatchObject({ code: 2 })
      await expect(promisify(execFile)(executable, ['--unregister'], { timeout: 5000, windowsHide: true })).rejects.toMatchObject({ code: 2 })
    } finally { await setCommand(`"${await realpath(executable)}" "%1"`) }
    await save('b'.repeat(64))
    await expect(promisify(execFile)(executable, ['--register'], { timeout: 5000, windowsHide: true })).rejects.toMatchObject({ code: 2 })
    await expect(promisify(execFile)(executable, ['--unregister'], { timeout: 5000, windowsHide: true })).rejects.toMatchObject({ code: 2 })
    await save(owner)
    await promisify(execFile)(executable, ['--unregister'], { timeout: 5000, windowsHide: true })
  })
