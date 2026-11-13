import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Startup from '../src/startup.ts'

const admin = vi.hoisted(() => ({
  address: vi.fn<() => Promise<string>>(),
  stop: vi.fn<(...args: unknown[]) => Promise<void>>(),
  associate: vi.fn<(...args: unknown[]) => Promise<void>>(),
  start: vi.fn<(...args: unknown[]) => Promise<{ pid: number }>>(),
  windowsInstall: vi.fn<(...args: unknown[]) => Promise<void>>(),
  windowsUninstall: vi.fn<(...args: unknown[]) => Promise<void>>(),
  linuxInstall: vi.fn<(...args: unknown[]) => Promise<void>>(),
  linuxUninstall: vi.fn<(...args: unknown[]) => Promise<void>>(),
  macInstall: vi.fn<(...args: unknown[]) => Promise<void>>(),
  macUninstall: vi.fn<(...args: unknown[]) => Promise<void>>(),
}))
vi.mock('../src/control.ts', async () => ({
  ...await vi.importActual<typeof import('../src/control.ts')>('../src/control.ts'),
  machineControlAddress: admin.address, requestLocalStop: admin.stop, forwardLocalAssociation: admin.associate,
}))
vi.mock('../src/background.ts', () => ({ startBackgroundService: admin.start }))
vi.mock('../src/windows-install.ts', () => ({ installWindowsUri: admin.windowsInstall, uninstallWindowsUri: admin.windowsUninstall }))
vi.mock('../src/posix-install.ts', () => ({ installPosixUri: admin.linuxInstall, uninstallPosixUri: admin.linuxUninstall }))
vi.mock('../src/macos-install.ts', () => ({ installMacosUri: admin.macInstall, uninstallMacosUri: admin.macUninstall }))

const limits: Startup.Config = { controlTimeoutMs: 5000, serviceStartTimeoutMs: 30000,
  serviceStartPollMs: 100, serviceStopTimeoutMs: 2000, maxManagementResponseBytes: 1048576 }

async function fixture(flags: readonly string[] = [], profile = true) {
  for (const mock of Object.values(admin)) mock.mockReset()
  admin.address.mockResolvedValue('private-control-address')
  admin.start.mockResolvedValue({ pid: 1234 })
  const root = await mkdtemp(join(tmpdir(), 'mcp-startup-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  onTestFinished(() => { stderr.mockRestore(); stdout.mockRestore() })
  const settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ server: { origin: 'https://agent.example', credentialRef: 'MCP_TOKEN' },
    directory: '.', identityFile: 'identity.yaml', services: [],
  }))
  const anchor = join(root, 'package.json')
  await writeFile(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: './lib/bin.js' } }))
  const exit = vi.fn<(code: number) => void>()
  ctx.provide('appExit', exit)
  ctx.provide('cmdlineArgs', { get: () => ['--config', settings, ...flags] })
  if (profile) ctx.provide('profileContext', { name: 'mcp-proxy', dir: root, home: root, cwd: root,
    patchPath: join(root, 'cordis.patch.yml'), installAnchor: anchor, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  return { ctx, root, settings, anchor, exit, stderr, stdout }
}

it('provides resolved foreground settings without starting an administrative command', async () => {
  const f = await fixture()
  await Startup.apply(f.ctx, limits)
  expect(f.ctx.mcpProxyStartup).toEqual({ settingsFile: f.settings, identityFile: join(f.root, 'identity.yaml') })
  expect(admin.start).not.toHaveBeenCalled()
  expect(admin.address).not.toHaveBeenCalled()
  expect(f.exit).not.toHaveBeenCalled()
})

it('accepts empty versioned desktop settings without requiring a preconfigured DSH', async () => {
  const f = await fixture()
  await writeFile(f.settings, JSON.stringify({ version: 2, directory: '.', identityFile: 'identity.yaml', servers: [], services: [] }),
    { mode: 0o600 })
  await Startup.apply(f.ctx, limits)
  expect(f.ctx.mcpProxyStartup).toMatchObject({ settingsFile: f.settings, identityFile: join(f.root, 'identity.yaml'), managed: true })
  expect(f.exit).not.toHaveBeenCalled()
})

it.each([['--start', '--stop'], ['--install', '--uninstall'], ['--stop', '--associate', 'private-invalid-uri']].map(flags => ({ flags })))(
  'rejects conflicting administrative flags %# without acquiring control or spawning', async ({ flags }) => {
    const f = await fixture(flags)
    await Startup.apply(f.ctx, limits)
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(f.stderr.mock.calls.flat().join('')).toContain('cannot be combined')
    expect(f.ctx.get('mcpProxyStartup')).toBeUndefined()
    expect(admin.address).not.toHaveBeenCalled()
    expect(admin.start).not.toHaveBeenCalled()
  })

it('reports invalid configuration before attempting background startup', async () => {
  const f = await fixture(['--start'])
  await writeFile(f.settings, '{private-invalid-json')
  await expect(Startup.apply(f.ctx, limits)).rejects.toThrow('Invalid or unreadable mcp-proxy configuration')
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(f.stderr).toHaveBeenCalledWith('mcp-proxy: configuration failed\n')
  expect(admin.start).not.toHaveBeenCalled()
})

it('rejects background startup outside the dsh profile launcher', async () => {
  const f = await fixture(['--start'], false)
  await expect(Startup.apply(f.ctx, limits)).rejects.toThrow('require a dsh profile launcher')
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(admin.start).not.toHaveBeenCalled()
})

it.each([null, {}, { name: 'foreign', bin: { dsh: 'bin.js' } }, { name: '@deepseek-ai/dsh', bin: null },
  { name: '@deepseek-ai/dsh', bin: { dsh: 1 } }])('rejects invalid launcher metadata before spawning %#', async (manifest) => {
  const f = await fixture(['--start'])
  await writeFile(f.anchor, JSON.stringify(manifest))
  await expect(Startup.apply(f.ctx, limits)).rejects.toThrow('Invalid dsh launcher manifest')
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(admin.start).not.toHaveBeenCalled()
})

it('passes fixed profile arguments and lifetime to background startup before requesting successful exit', async () => {
  const f = await fixture(['--start'])
  await Startup.apply(f.ctx, limits)
  expect(admin.start).toHaveBeenCalledExactlyOnceWith({ node: process.execPath, cli: join(f.root, 'lib/bin.js'),
    profile: 'mcp-proxy', profileDir: f.root, home: f.root, cwd: f.root, settings: f.settings, address: 'private-control-address',
    controlTimeoutMs: limits.controlTimeoutMs, startupTimeoutMs: limits.serviceStartTimeoutMs,
    pollIntervalMs: limits.serviceStartPollMs, shutdownTimeoutMs: limits.serviceStopTimeoutMs,
  }, expect.any(AbortSignal))
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(f.ctx.get('mcpProxyStartup')).toBeUndefined()
  const signal = admin.start.mock.calls[0]![1] as AbortSignal
  expect(signal.aborted).toBe(false)
  await f.ctx.fiber.dispose()
  expect(signal.aborted).toBe(true)
})

it('reports background failure without printing readiness or publishing runtime settings', async () => {
  const f = await fixture(['--start'])
  admin.start.mockRejectedValue(new Error('fixture startup rejected'))
  await expect(Startup.apply(f.ctx, limits)).rejects.toThrow('fixture startup rejected')
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(f.stderr).toHaveBeenCalledWith('mcp-proxy: background-start failed\n')
  expect(f.stdout).not.toHaveBeenCalled()
  expect(f.ctx.get('mcpProxyStartup')).toBeUndefined()
})

it('requests local stop even when the configuration file has been removed', async () => {
  const f = await fixture(['--stop'])
  await rm(f.settings)
  await Startup.apply(f.ctx, limits)
  expect(admin.stop).toHaveBeenCalledExactlyOnceWith('private-control-address', limits.controlTimeoutMs)
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(f.ctx.get('mcpProxyStartup')).toBeUndefined()
})

it('forwards only a validated URI transaction to the existing owner', async () => {
  const id = 'a'.repeat(43)
  const f = await fixture(['--associate', `mcp-proxy://associate/${id}`])
  await Startup.apply(f.ctx, limits)
  expect(admin.associate).toHaveBeenCalledExactlyOnceWith('private-control-address', id, limits.controlTimeoutMs)
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(f.ctx.get('mcpProxyStartup')).toBeUndefined()
})

it('rejects an unsafe activation URI before contacting the local owner', async () => {
  const f = await fixture(['--associate', 'mcp-proxy://associate/private?token=secret'])
  await expect(Startup.apply(f.ctx, limits)).rejects.toThrow('Invalid mcp-proxy activation')
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(f.stderr).toHaveBeenCalledWith('mcp-proxy: association failed\n')
  expect(admin.address).not.toHaveBeenCalled()
  expect(admin.associate).not.toHaveBeenCalled()
})

it.each(['--install', '--uninstall'])('dispatches %s to the native platform installer with a cancellable lifetime', async (flag) => {
  const f = await fixture([flag])
  await Startup.apply(f.ctx, limits)
  const selected = process.platform === 'win32' ? [admin.windowsInstall, admin.windowsUninstall]
    : process.platform === 'linux' ? [admin.linuxInstall, admin.linuxUninstall] : [admin.macInstall, admin.macUninstall]
  const installer = selected[flag === '--install' ? 0 : 1]!
  expect(installer).toHaveBeenCalledOnce()
  expect(installer.mock.calls[0]![0]).toMatchObject({ profile: 'mcp-proxy', settings: f.settings, node: process.execPath,
    cli: join(f.root, 'lib/bin.js'), profileDir: f.root,
  })
  const signal = installer.mock.calls[0]!.at(-1) as AbortSignal
  expect(signal.aborted).toBe(false)
  await f.ctx.fiber.dispose()
  expect(signal.aborted).toBe(true)
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(f.ctx.get('mcpProxyStartup')).toBeUndefined()
})
