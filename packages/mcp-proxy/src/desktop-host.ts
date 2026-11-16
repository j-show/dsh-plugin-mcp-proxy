/** Node/DSH supervisor owned by the Tauri process; no browser-accessible network listener. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type * as DesktopApi from '@j-show/mcp-proxy-runtime/desktop'
import type { LocalDesktopSnapshot, LocalManagementReply } from '@j-show/mcp-proxy-local/management'
import type { BootstrapState } from './client/api.ts'
import { ensureLocalProfile } from './ensure-profile.ts'
import { applyBundledConnections } from './bundled-connections.ts'
import { stopDesktopService } from './service-shutdown.ts'
import { desktopMessages } from './client/messages.ts'

export function desktopDataDirectory(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') {
    if (!environment.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required')
    return join(environment.LOCALAPPDATA, 'McpProxy')
  }
  if (platform === 'darwin') return join(home, 'Library/Application Support/McpProxy')
  if (platform === 'linux') return join(environment.XDG_DATA_HOME || join(home, '.local/share'), 'mcp-proxy')
  throw new Error('Unsupported desktop platform')
}
export interface DesktopHostOptions {
  resources: string
  executable: string
  cwd: string
  documents: string
  args: string[]
  locale: string
  registerProtocol: boolean
}
export interface DesktopState { bootstrap: BootstrapState; snapshot?: LocalDesktopSnapshot; menu: { show: string; exit: string; servers: string[] } }
interface HostDependencies {
  loadApi(): Promise<typeof DesktopApi>
  initializeProfile: typeof ensureLocalProfile
  applyPresets: typeof applyBundledConnections
}
export class DesktopHost {
  private api: typeof DesktopApi | undefined
  private child: ChildProcess | undefined
  private snapshot: LocalDesktopSnapshot | undefined
  private bootstrap: BootstrapState = 'starting'
  private timer: ReturnType<typeof setTimeout> | undefined
  private exiting = false
  private ownedPid: number | undefined
  private protocolReady = false
  private published: string | undefined
  private closing: Promise<void> | undefined
  private readonly ready = Promise.withResolvers<void>()
  private readonly data: string
  private readonly home: string
  private readonly settings: string
  private readonly uri: string | undefined
  private readonly t: ReturnType<typeof desktopMessages>
  constructor(private readonly options: DesktopHostOptions, private readonly emit: (event: string, payload: unknown) => void,
    private readonly dependencies: Partial<HostDependencies> = {}) {
    const parsed = parseArgs({ args: options.args, allowPositionals: true, options: { config: { type: 'string' }, start: { type: 'boolean' } } })
    this.uri = parsed.positionals[0]
    if (parsed.positionals.length > 1 || (this.uri && !this.uri.startsWith('mcp-proxy:'))) throw new Error('Invalid desktop arguments')
    this.data = join(desktopDataDirectory(process.platform, process.env, homedir()), 'data')
    this.home = process.env.DSH_HOME || join(this.data, 'dsh')
    this.settings = parsed.values.config ? resolve(options.cwd, parsed.values.config) : join(this.data, 'settings.json')
    this.t = desktopMessages(options.locale)
    void this.ready.promise.catch(() => {})
  }
  state(): DesktopState {
    return { bootstrap: this.bootstrap, ...(this.snapshot ? { snapshot: this.snapshot } : {}), menu: {
      show: this.t('show'), exit: this.t('exit'), servers: (this.snapshot?.servers ?? []).map(row => `${row.origin} — ${this.t(row.state)}`),
    } }
  }
  private publish(state?: BootstrapState): void {
    if (state) this.bootstrap = state
    const value = this.state(), encoded = JSON.stringify(value)
    if (encoded !== this.published) { this.published = encoded; this.emit('state', value) }
  }
  private async load(): Promise<typeof DesktopApi> {
    if (this.api) return this.api
    if (this.dependencies.loadApi) { this.api = await this.dependencies.loadApi(); return this.api }
    const require = createRequire(join(this.options.resources, 'dsh/package.json'))
    this.api = await import(pathToFileURL(require.resolve('@j-show/mcp-proxy-runtime/desktop')).href) as typeof DesktopApi
    return this.api
  }
  async start(): Promise<DesktopState> {
    try {
      const api = await this.load()
      if (this.uri) api.parseProxyActivation(this.uri)
      await (this.dependencies.initializeProfile ?? ensureLocalProfile)(dirname(this.options.resources), this.home)
      const store = await api.ManagedSettingsStore.open({ filename: this.settings,
        directory: join(this.options.documents, 'mcp-proxy-workspace'), identityFile: join(this.data, 'identity.yaml'),
        legacyIdentityRef: 'MCP_PROXY_INSTALLATION_KEY', waitMs: 5000 })
      await (this.dependencies.applyPresets ?? applyBundledConnections)(join(this.options.resources, 'connection-presets.json'), join(this.data, 'trust'), store)
      const address = await api.machineControlAddress()
      const current = await api.requestLocalStatus(address, 2000).catch(() => undefined)
      if (!current) await this.startService(api)
      const reply = await this.request({ kind: 'snapshot' })
      const key = (file: string) => process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file)
      if (!reply.ok || key(reply.snapshot.settingsFile) !== key(this.settings)) throw new Error('Another configuration owns the local service')
      this.ownedPid = reply.snapshot.pid
      this.emit('owner',{pid:this.ownedPid,settingsFile:this.settings})
      this.ready.resolve()
      if (this.options.registerProtocol) await this.registerUri()
      else { this.protocolReady = true; this.publish('ready') }
      this.poll()
      if (this.uri) await this.activate(this.uri)
      return this.state()
    } catch (error) { this.ready.reject(error); this.publish('startupFailed'); this.emit('show', null); throw error }
  }
  private async startService(api: typeof DesktopApi): Promise<void> {
    const node = join(this.options.resources, 'dsh/runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    this.child = spawn(node, ['--import', pathToFileURL(join(this.options.resources, 'desktop-service-owner.mjs')).href,
      join(this.options.resources, 'dsh/lib/bin.js'), '--profile', 'mcp-proxy', '--config', this.settings], {
      cwd: this.options.cwd, env: { ...process.env, DSH_HOME: this.home, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, shell: false,
    })
    let spawnError: Error | undefined
    this.child.once('error', error => { spawnError = error })
    this.child.stdout?.resume(); this.child.stderr?.resume()
    this.child.on('exit', code => {
      if (this.exiting) return
      if (this.snapshot && code === 0) this.emit('exit', null)
      else { this.publish('startupFailed'); this.emit('show', null) }
    })
    const deadline = performance.now() + 60000
    while (performance.now() < deadline) {
      if (spawnError || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('Owned service exited during startup')
      const status = await api.requestLocalStatus(await api.machineControlAddress(), 1000).catch(() => undefined)
      if (status?.ready && status.pid === this.child.pid) return
      await delay(100)
    }
    throw new Error('Owned service startup deadline')
  }
  private async request(command: unknown): Promise<LocalManagementReply> {
    const api = await this.load()
    const reply = api.parseLocalManagementReply(await api.requestLocalManagement(await api.machineControlAddress(), command, 60000, 1048576))
    if (reply.ok && !this.exiting) { this.snapshot = reply.snapshot; this.publish() }
    return reply
  }
  async manage(command: unknown): Promise<LocalManagementReply> {
    await this.ready.promise
    const parsed = (await this.load()).parseLocalManagementCommand(command)
    if (parsed.kind === 'activate') throw new Error('Activation is reserved for the native entry')
    return this.request(parsed)
  }
  async activate(uri: string): Promise<void> {
    await this.ready.promise
    ;(await this.load()).parseProxyActivation(uri)
    if (!(await this.request({ kind: 'activate', uri })).ok) this.emit('show', null)
  }
  private poll(): void {
    if (this.exiting) return
    this.timer = setTimeout(() => {
      void this.request({ kind: 'snapshot' }).then(() => {
        if (this.bootstrap === 'startupFailed') this.publish(this.protocolReady ? 'ready' : 'protocolFailed')
      }).catch(() => { this.publish('startupFailed') }).finally(() => { this.poll() })
    }, 1000)
  }
  async registerUri(): Promise<void> {
    try { await this.installUri(false); this.protocolReady = true; this.publish('ready') }
    catch { this.protocolReady = false; this.publish('protocolFailed') }
  }
  async installUri(remove: boolean): Promise<void> {
    const api = await this.load()
    const spec = { profileDir: join(this.home, 'profiles/mcp-proxy'), home: this.home, profile: 'mcp-proxy',
      node: this.options.executable, cli: join(this.options.resources, 'dsh/lib/bin.js'), settings: this.settings,
      registryKey: 'Software\\Classes\\mcp-proxy', desktop: true, electronRunAsNode: false, localAppData: process.env.LOCALAPPDATA }
    const signal = new AbortController().signal
    if (process.platform === 'win32') {
      if (remove) await api.uninstallWindowsUri(spec, 10000, signal)
      else await api.installWindowsUri(spec, join(this.options.resources, 'dsh/node_modules/@j-show/mcp-proxy-runtime/lib/mcp-proxy.exe'), 10000, signal)
    } else if (process.platform === 'darwin') {
      const local = { ...spec, userHome: homedir() }
      if (remove) await api.uninstallMacosUri(local, 10000, signal); else await api.installMacosUri(local, 10000, signal)
    } else {
      const local = { ...spec, userHome: homedir(), platform: 'linux' as const, dataHome: process.env.XDG_DATA_HOME || join(homedir(), '.local/share') }
      if (remove) await api.uninstallPosixUri(local, 10000, signal); else await api.installPosixUri(local, 10000, signal)
    }
  }
  close(): Promise<void> { return this.closing ??= this.stop().catch(error => { this.closing = undefined; throw error }) }
  private async stop(): Promise<void> {
    this.exiting = true; clearTimeout(this.timer)
    const expectedPid = this.child?.pid ?? this.ownedPid
    if (!expectedPid) return
    const api = await this.load(), awaitAddress = await api.machineControlAddress()
    try {
      await stopDesktopService({ expectedPid, timeoutMs: 30000, pollMs: 100,
        status: () => api.requestLocalStatus(awaitAddress, 1000).catch(() => undefined),
        stop: pid => api.requestLocalStop(awaitAddress, 5000, pid), exited: () => {
          if (this.child) return this.child.exitCode !== null || this.child.signalCode !== null
          try { process.kill(expectedPid, 0); return false } catch { return true }
        } })
    } catch (error) { this.exiting = false; this.publish('stopFailed'); this.poll(); throw error }
  }
}
