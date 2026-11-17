/** Local application's command-line configuration provider. */
import type { Context } from '@deepseek-ai/cordis'
import { dirname, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import type {} from '@deepseek-ai/dsh-app-boot'
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { readMcpProxySettings, parseManagedMcpSettings, parseLocalManagementReply } from '@jshow/app-mcp-proxy/local'
import { parseProxyActivation } from '@jshow/app-mcp-proxy/protocol'
import z from '@deepseek-ai/schemastery'
import { forwardLocalAssociation, machineControlAddress, requestLocalStop, requestLocalManagement } from './control.ts'
import { installWindowsUri, uninstallWindowsUri } from './windows-install.ts'
import { installPosixUri, uninstallPosixUri } from './posix-install.ts'
import { installMacosUri, uninstallMacosUri } from './macos-install.ts'
import { startBackgroundService } from './background.ts'

/** Stable startup plugin name. */
export const name = 'mcp-proxy-startup'
/** Launcher-owned immutable command line. */
export const inject = ['cmdlineArgs']
/** Resolved filenames shared by local application rows. */
export interface StartupValues { readonly settingsFile: string; readonly identityFile: string; readonly managed?: boolean }
/** Deadline for an OS activation entry to contact the existing local runtime. */
export interface Config {
  readonly controlTimeoutMs: number
  readonly serviceStartTimeoutMs: number
  readonly serviceStartPollMs: number
  readonly serviceStopTimeoutMs: number
  readonly maxManagementResponseBytes: number
}
/** Validated activation deadline. */
export const Config: z<Config> = z.object({
  controlTimeoutMs: z.natural().min(1).max(2147483647).default(5000),
  serviceStartTimeoutMs: z.natural().min(1).max(2147483647).default(30000),
  serviceStartPollMs: z.natural().min(1).max(2147483647).default(100),
  serviceStopTimeoutMs: z.natural().min(1).max(2147483647).default(2000),
  maxManagementResponseBytes: z.natural().min(1).default(1048576),
})

interface Arguments {
  readonly config: string
  readonly start?: boolean
  readonly associate?: string
  readonly stop?: boolean
  readonly install?: boolean
  readonly uninstall?: boolean
}
type CommandStage = 'arguments' | 'configuration' | 'background-start' | 'uri-installation' | 'local-stop' | 'association'
declare module '@deepseek-ai/cordis' { interface Context { mcpProxyStartup: StartupValues } }
/** @param ctx - application startup scope. @param config - activation request deadline. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const phase: { value: CommandStage } = { value: 'arguments' }
  let startup: StartupValues | undefined
  try { startup = await configure(ctx, config, phase) } catch (error) {
    process.stderr.write(`mcp-proxy: ${phase.value} failed\n`)
    ctx.get('appExit')?.(1)
    throw error
  }
  const entry = ctx.fiber.entry
  if (startup !== undefined && entry !== undefined) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        const required = ['@jshow/app-mcp-proxy/runtime/startup', '@deepseek-ai/dsh-credentials-local', '@jshow/app-mcp-proxy/runtime']
        const siblings = Object.values(entry.parent.tree.store).filter(candidate => candidate.parent === entry.parent)
        // ACTIVE is ordinal 2 in the pinned Cordis const enum.
        if (required.some(name => !siblings.some(candidate => candidate.options.name === name && candidate.fiber?.state === 2))) {
          process.stderr.write('mcp-proxy: required profile entries did not start\n')
          ctx.get('appExit')?.(1)
        }
      }, config.serviceStartTimeoutMs)
      return () => { clearTimeout(timer) }
    })
  }
}

async function configure(ctx: Context, config: Config, phase: { value: CommandStage }): Promise<StartupValues | undefined> {
  const state = { parsed: false }
  const program = new Command().name('dsh --profile mcp-proxy')
    .description('Run configured local MCP services through an authenticated outbound DSH connection.')
    .requiredOption('--config <file>', 'local mcp-proxy JSON configuration')
    .option('--start', 'start the same profile in the background and wait for acknowledged readiness')
    .option('--associate <uri>', 'forward an association URI to the existing local runtime and exit')
    .option('--stop', 'request graceful shutdown of the existing local runtime')
    .option('--install', 'register the URI launcher for this local profile')
    .option('--uninstall', 'remove the URI launcher owned by this local profile')
    .action(() => {
      const options = program.opts<Arguments>()
      if ([options.associate !== undefined, options.start, options.stop, options.install, options.uninstall].filter(Boolean).length > 1) {
        program.error('--start, --associate, --stop, --install and --uninstall cannot be combined')
      }
      state.parsed = true
    })
  parseCmdline(ctx, program)
  if (!state.parsed) return
  const options = program.opts<Arguments>()
  if (options.start) {
    phase.value = 'configuration'
    await readStartupSettings(options.config)
    phase.value = 'background-start'
    const spec = await resolveLauncher(ctx, options.config)
    const lifetime = new AbortController()
    ctx.effect(() => () => { lifetime.abort() })
    await startBackgroundService({ ...spec, address: await machineControlAddress(), controlTimeoutMs: config.controlTimeoutMs,
      startupTimeoutMs: config.serviceStartTimeoutMs, pollIntervalMs: config.serviceStartPollMs,
      shutdownTimeoutMs: config.serviceStopTimeoutMs,
    }, lifetime.signal)
    process.stdout.write('mcp-proxy: background service ready\n')
    ctx.get('appExit')?.(0)
    return
  }
  if (options.install || options.uninstall) {
    phase.value = 'uri-installation'
    if (process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin') {
      throw new Error('URI installation is not available on this platform')
    }
    const spec = { ...await resolveLauncher(ctx, options.config), registryKey: 'Software\\Classes\\mcp-proxy',
      ...(process.versions.electron === undefined ? {} : { electronRunAsNode: true }),
    }
    const lifetime = new AbortController()
    ctx.effect(() => () => { lifetime.abort() })
    if (process.platform === 'linux') {
      const userHome = homedir()
      const local = { ...spec, platform: 'linux' as const, userHome, dataHome: process.env.XDG_DATA_HOME || join(userHome, '.local/share') }
      if (options.install) await installPosixUri(local, config.controlTimeoutMs, lifetime.signal)
      else await uninstallPosixUri(local, config.controlTimeoutMs, lifetime.signal)
    } else if (process.platform === 'darwin') {
      const local = { ...spec, userHome: homedir() }
      if (options.install) await installMacosUri(local, config.controlTimeoutMs, lifetime.signal)
      else await uninstallMacosUri(local, config.controlTimeoutMs, lifetime.signal)
    } else if (options.install) {
      const root = dirname(fileURLToPath(import.meta.resolve('@jshow/app-mcp-proxy/package.json')))
      await installWindowsUri(spec, join(root, 'lib/mcp-proxy.exe'), config.controlTimeoutMs, lifetime.signal)
    } else await uninstallWindowsUri(spec, config.controlTimeoutMs, lifetime.signal)
    ctx.get('appExit')?.(0)
    return
  }
  if (options.stop) {
    phase.value = 'local-stop'
    await requestLocalStop(await machineControlAddress(), config.controlTimeoutMs)
    ctx.get('appExit')?.(0)
    return
  }
  if (options.associate !== undefined) {
    phase.value = 'association'
    const activation = parseProxyActivation(options.associate)
    if (activation.kind === 'pair') {
      const reply = parseLocalManagementReply(await requestLocalManagement(await machineControlAddress(),
        { kind: 'activate', uri: options.associate }, config.serviceStartTimeoutMs, config.maxManagementResponseBytes))
      if (!reply.ok) throw new Error('Local desktop activation failed')
      ctx.get('appExit')?.(0)
      return
    }
    await forwardLocalAssociation(await machineControlAddress(), activation.requestId, config.controlTimeoutMs)
    ctx.get('appExit')?.(0)
    return
  }
  phase.value = 'configuration'
  const startup = await readStartupSettings(options.config)
  ctx.provide('mcpProxyStartup', startup)
  return startup
}

async function readStartupSettings(filename: string): Promise<StartupValues> {
  const settingsFile = resolve(filename)
  try {
    const raw: unknown = JSON.parse(await readFile(settingsFile, 'utf8'))
    if (typeof raw === 'object' && raw !== null && 'version' in raw && raw.version === 2) {
      const settings = parseManagedMcpSettings(raw, dirname(settingsFile))
      return { settingsFile, identityFile: settings.identityFile, managed: true }
    }
    const settings = await readMcpProxySettings(settingsFile)
    return { settingsFile, identityFile: settings.identityFile }
  } catch (_error) { throw new Error('Invalid or unreadable mcp-proxy configuration') }
}

async function resolveLauncher(ctx: Context, settings: string) {
  const profile = ctx.get('profileContext')
  if (profile === undefined) throw new Error('Local service startup and installation require a dsh profile launcher')
  const manifest: unknown = JSON.parse(await readFile(profile.installAnchor, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('name' in manifest) || manifest.name !== '@deepseek-ai/dsh'
    || !('bin' in manifest) || typeof manifest.bin !== 'object' || manifest.bin === null
    || !('dsh' in manifest.bin) || typeof manifest.bin.dsh !== 'string') throw new Error('Invalid dsh launcher manifest')
  return { profileDir: profile.dir, home: profile.home, profile: profile.name, node: process.execPath,
    cli: resolve(dirname(profile.installAnchor), manifest.bin.dsh), settings: resolve(settings), cwd: profile.cwd,
  }
}
