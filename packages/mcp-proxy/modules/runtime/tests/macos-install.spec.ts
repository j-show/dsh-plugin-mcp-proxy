import { expect, it, onTestFinished } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installMacosUri, uninstallMacosUri } from '../src/macos-install.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-macos-uri-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const spec = { userHome: root, profileDir: join(root, 'profile'), home: join(root, 'dsh home'), profile: 'mcp-proxy',
    node: join(root, 'node'), cli: join(root, 'dsh.js'), settings: join(root, 'settings.json'),
  }
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let registered: string | null = null
  const run = async (file: string, args: readonly string[]) => {
    calls.push({ file, args })
    if (file === '/usr/bin/osascript') return registered ?? ''
    if (file.endsWith('/lsregister')) registered = args[0] === '-f' ? args[1]! : null
    if (file === '/usr/bin/osacompile') {
      const app = args[args.indexOf('-o') + 1]!
      await mkdir(join(app, 'Contents/MacOS'), { recursive: true })
      await writeFile(join(app, 'Contents/MacOS/applet'), 'fixture compiled executable')
      await writeFile(join(app, 'Contents/Info.plist'), 'fixture app plist')
    }
    return ''
  }
  return { root, spec, calls, run }
}

it('builds and registers a macOS application owning open-location Apple events', async () => {
  const { spec, calls, run } = await setup()
  const app = await installMacosUri(spec, 5000, new AbortController().signal, run)
  expect(await readFile(join(app, 'Contents/MacOS/applet'), 'utf8')).toBe('fixture compiled executable')
  const compile = calls.find(call => call.file === '/usr/bin/osacompile')!
  expect(compile.args.at(-1)).toContain('on open location incomingUrl')
  expect(compile.args.at(-1)).toContain('quoted form of incomingUrl')
  expect(compile.args.at(-1)).toContain('--associate')
  expect(calls).toContainEqual({ file: '/usr/bin/codesign', args: ['--force', '--sign', '-', compile.args[1]] })
  expect(calls).toContainEqual({ file: expect.stringContaining('/lsregister'), args: ['-f', app] })
  const count = calls.filter(call => call.file === '/usr/bin/osacompile').length
  expect(await installMacosUri(spec, 5000, new AbortController().signal, run)).toBe(app)
  expect(calls.filter(call => call.file === '/usr/bin/osacompile')).toHaveLength(count)
  await uninstallMacosUri(spec, 5000, new AbortController().signal, run)
  await expect(readFile(join(app, 'Contents/Info.plist'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps a compiled application after registration failure for a safe retry', async () => {
  const { spec, run } = await setup()
  let fail = true
  const interrupted = async (file: string, args: readonly string[]) => {
    if (file.endsWith('/lsregister') && fail) { fail = false; throw new Error('fixture registration unavailable') }
    return run(file, args)
  }
  await expect(installMacosUri(spec, 5000, new AbortController().signal, interrupted)).rejects.toThrow('fixture registration unavailable')
  const app = await installMacosUri(spec, 5000, new AbortController().signal, interrupted)
  expect(await readFile(join(app, 'Contents/Info.plist'), 'utf8')).toBe('fixture app plist')
})

it('preserves an application with added or changed files during uninstall', async () => {
  const { spec, run } = await setup()
  const app = await installMacosUri(spec, 5000, new AbortController().signal, run)
  await writeFile(join(app, 'user.txt'), 'keep')
  await expect(uninstallMacosUri(spec, 5000, new AbortController().signal, run)).rejects.toThrow('changed')
  expect(await readFile(join(app, 'user.txt'), 'utf8')).toBe('keep')
})

it('refuses another profile and a pre-existing unowned application', async () => {
  const { root, spec, run } = await setup()
  await mkdir(join(root, 'Applications/mcp-proxy.app'), { recursive: true })
  await expect(installMacosUri(spec, 5000, new AbortController().signal, run)).rejects.toThrow('owned')
})

it('refuses a foreign default application before compiling a URI handler', async () => {
  const { root, spec, run, calls } = await setup()
  const foreign = join(root, 'Other.app')
  await expect(installMacosUri(spec, 5000, new AbortController().signal,
    async (file, args) => file === '/usr/bin/osascript' ? foreign : run(file, args)))
    .rejects.toThrow('another application')
  expect(calls.some(call => call.file === '/usr/bin/osacompile')).toBe(false)
})

it('does not report success when registration leaves the URI scheme unresolved', async () => {
  const { spec, run } = await setup()
  await expect(installMacosUri(spec, 5000, new AbortController().signal,
    async (file, args) => file === '/usr/bin/osascript' ? '' : run(file, args)))
    .rejects.toThrow('not selected')
})
