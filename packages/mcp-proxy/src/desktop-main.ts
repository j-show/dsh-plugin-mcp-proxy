/** Native window/tray owner supervising the real packaged dsh profile. */
import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import type * as DesktopApi from '@j-show/mcp-proxy-runtime/desktop'
import type { LocalDesktopSnapshot, LocalManagementReply } from '@j-show/mcp-proxy-local/management'
import type { BootstrapState } from './client/api.ts'
import { desktopMessages } from './client/messages.ts'
import { DesktopLifetime } from './desktop-lifetime.ts'
import { electronProfileLaunch } from './profile-launch.ts'
import { stopDesktopService } from './service-shutdown.ts'
import { applyBundledConnections } from './bundled-connections.ts'
import { ensureLocalProfile } from './ensure-profile.ts'

/** @param runtime - verified permanent Electron distribution. @param args - desktop arguments. @param cwd - original invoking directory. */
export async function runDesktop(runtime: string, args: readonly string[], cwd: string, registerProtocol = true): Promise<void> {
  if (!app.requestSingleInstanceLock()) { app.exit(0); return }
  const controller = new DesktopMain(runtime, cwd, registerProtocol)
  app.on('second-instance', (_event, argv) => { void controller.activation(argv).catch(() => { controller.show() }) })
  app.on('before-quit', (event) => { event.preventDefault(); void controller.exit() })
  try { await controller.start(args) } catch (_error) { controller.failed() }
}

class DesktopMain {
  private readonly t = desktopMessages(app.getLocale())
  private readonly window: BrowserWindow
  private readonly tray: Tray
  private readonly lifetime: DesktopLifetime
  private api: typeof DesktopApi | undefined
  private child: ChildProcess | undefined
  private snapshot: LocalDesktopSnapshot | undefined
  private bootstrap: BootstrapState = 'starting'
  private filename = ''
  private home = ''
  private exiting = false
  private wasReady = false
  private protocolReady = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private ready = Promise.withResolvers<undefined>()
  private exitWork: Promise<void> | undefined

  constructor(private readonly runtime: string, private readonly cwd: string, private readonly registerProtocol = true) {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'app-icon.png'))
    this.window = new BrowserWindow({ width: 1000, height: 750, minWidth: 780, minHeight: 560, show: false,
      title: this.t('brand'), icon, autoHideMenuBar: true, backgroundColor: '#f7f8f8',
      webPreferences: { preload: join(app.getAppPath(), 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    this.tray = new Tray(icon.resize({ width: 20, height: 20 }))
    this.lifetime = new DesktopLifetime(this.window, () => this.stopService(), () => {
      clearTimeout(this.pollTimer); this.tray.destroy(); app.exit(0)
    })
    this.window.on('close', (event) => { event.preventDefault(); this.lifetime.closeWindow() })
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event) => { event.preventDefault() })
    this.window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    this.window.webContents.on('did-finish-load', () => { this.broadcast() })
    this.tray.on('click', () => { this.show() })
    this.updateTray()
    ipcMain.handle('mcp-proxy:manage', async (event, input: unknown) => {
      this.assertSender(event)
      if (this.api === undefined || !this.wasReady) throw new Error('Local desktop is starting')
      const command = this.api.parseLocalManagementCommand(input)
      if (command.kind === 'activate') throw new Error('Activation is native-entry only')
      const reply = await this.request(command)
      return reply
    })
    ipcMain.handle('mcp-proxy:exit', async (event) => { this.assertSender(event); await this.exit() })
    ipcMain.handle('mcp-proxy:register-uri', async (event) => { this.assertSender(event); await this.registerUri() })
    void this.window.loadFile(join(app.getAppPath(), 'index.html'))
  }

  async start(args: readonly string[]): Promise<void> {
    const parsed = parseArgs({ args: [...args], allowPositionals: true, options: { config: { type: 'string' }, start: { type: 'boolean' } } })
    const anchor = join(this.runtime, 'resources/dsh/package.json')
    const require = createRequire(anchor)
    this.api = await import(pathToFileURL(require.resolve('@j-show/mcp-proxy-runtime/desktop')).href) as typeof DesktopApi
    const activation = parsed.positionals[0]
    if (parsed.positionals.length > 1 || (activation !== undefined && !activation.startsWith('mcp-proxy:'))) throw new Error('Invalid desktop arguments')
    if (activation !== undefined) this.api.parseProxyActivation(activation)
    const data = join(app.getPath('userData'), '..', 'data')
    this.filename = parsed.values.config === undefined ? join(data, 'settings.json') : resolve(this.cwd, parsed.values.config)
    this.home = process.env.DSH_HOME ?? join(data, 'dsh')
    await ensureLocalProfile(this.runtime, this.home)
    if (!parsed.values.start && activation === undefined) this.show()
    const store = await this.api.ManagedSettingsStore.open({ filename: this.filename,
      directory: join(app.getPath('documents'), 'mcp-proxy-workspace'), identityFile: join(data, 'identity.yaml'),
      legacyIdentityRef: 'MCP_PROXY_INSTALLATION_KEY', waitMs: 5000 })
    await applyBundledConnections(join(this.runtime, 'resources/connection-presets.json'), join(data, 'trust'), store)
    const address = await this.api.machineControlAddress()
    const current = await this.api.requestLocalStatus(address, 2000).catch(() => undefined)
    if (current !== undefined) {
      const reply = await this.request({ kind: 'snapshot' })
      if (!reply.ok || resolve(reply.snapshot.settingsFile).toLowerCase() !== resolve(this.filename).toLowerCase()) {
        throw new Error('Another configuration owns the local service')
      }
    } else {
      const launch = electronProfileLaunch(this.runtime, ['--config', this.filename], { ...process.env, DSH_HOME: this.home })
      this.child = spawn(launch.command, launch.args, { env: launch.env, cwd: this.cwd, windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'] })
      this.child.stdout?.resume(); this.child.stderr?.resume()
      this.child.on('error', () => { this.failed() })
      this.child.on('exit', (code) => {
        if (this.exiting) return
        if (this.wasReady && code === 0) { void this.lifetime.exit().catch(() => { this.failed() }) }
        else this.failed()
      })
      const deadline = performance.now() + 60000
      let loaded = false
      while (performance.now() < deadline) {
        if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('Local service exited during startup')
        const status = await this.api.requestLocalStatus(address, 1000).catch(() => undefined)
        if (status !== undefined && status.pid === this.child.pid && status.ready) { loaded = true; break }
        await delay(100)
      }
      if (!loaded) throw new Error('Local service startup deadline')
      const reply = await this.request({ kind: 'snapshot' })
      if (!reply.ok) throw new Error('Local management did not become ready')
    }
    this.wasReady = true
    this.ready.resolve(undefined)
    if (this.registerProtocol) await this.registerUri()
    else { this.protocolReady = true; this.setBootstrap('ready') }
    this.poll()
    if (activation !== undefined) await this.activation([activation])
  }

  async activation(args: readonly string[]): Promise<void> {
    const uri = args.find(value => value.startsWith('mcp-proxy:'))
    if (uri === undefined) { this.show(); return }
    await this.ready.promise
    const reply = await this.request({ kind: 'activate', uri })
    if (!reply.ok) this.show()
  }

  private async request(input: unknown): Promise<LocalManagementReply> {
    const api = this.api
    if (api === undefined) throw new Error('Local management unavailable')
    const reply = api.parseLocalManagementReply(await api.requestLocalManagement(await api.machineControlAddress(), input, 60000, 1048576))
    if (reply.ok && !this.exiting) {
      const changed = JSON.stringify(reply.snapshot) !== JSON.stringify(this.snapshot)
      this.snapshot = reply.snapshot
      if (changed) this.broadcast()
    }
    return reply
  }

  private poll(): void {
    if (this.exiting) return
    this.pollTimer = setTimeout(() => {
      void this.request({ kind: 'snapshot' }).then((reply) => {
        if (reply.ok && this.bootstrap === 'startupFailed') this.setBootstrap(this.protocolReady ? 'ready' : 'protocolFailed')
      }).catch(() => { this.setBootstrap('startupFailed') }).finally(() => { this.poll() })
    }, 1000)
  }

  async registerUri(): Promise<void> {
    const api = this.api
    if (api === undefined || !this.wasReady) throw new Error('Local service is not ready')
    try {
      await api.installWindowsUri({ node: join(this.runtime, 'mcp-proxy.exe'), cli: join(this.runtime, 'resources/dsh/lib/bin.js'),
        settings: this.filename, home: this.home, profile: 'mcp-proxy', profileDir: join(this.home, 'profiles/mcp-proxy'),
        registryKey: 'Software\\Classes\\mcp-proxy', desktop: true, electronRunAsNode: false,
      }, join(this.runtime, 'resources/dsh/node_modules/@j-show/mcp-proxy-runtime/lib/mcp-proxy.exe'), 10000, new AbortController().signal)
      this.protocolReady = true; this.setBootstrap('ready')
    } catch (_error) { this.protocolReady = false; this.setBootstrap('protocolFailed') }
  }

  private async stopService(): Promise<void> {
    this.exiting = true
    clearTimeout(this.pollTimer)
    const api = this.api
    if (api === undefined) return
    const address = await api.machineControlAddress()
    const expectedPid = this.child?.pid ?? (this.wasReady ? this.snapshot?.pid : undefined)
    await stopDesktopService({ expectedPid, timeoutMs: 30000, pollMs: 100,
      status: () => api.requestLocalStatus(address, 1000).catch(() => undefined),
      stop: pid => api.requestLocalStop(address, 5000, pid), exited: () => {
        if (this.child !== undefined) return this.child.exitCode !== null || this.child.signalCode !== null
        if (expectedPid === undefined) return true
        try { process.kill(expectedPid, 0); return false } catch (_error) { return true }
      },
    })
  }

  exit(): Promise<void> {
    return this.exitWork ??= this.finishExit().finally(() => { this.exitWork = undefined })
  }

  private async finishExit(): Promise<void> {
    try { await this.lifetime.exit() } catch (_error) { this.exiting = false; this.setBootstrap('stopFailed'); this.poll() }
  }

  show(): void { this.lifetime.showWindow() }
  failed(): void { this.ready.reject(new Error('Local service startup failed')); void this.ready.promise.catch(() => {}); this.setBootstrap('startupFailed'); this.show() }

  private setBootstrap(state: BootstrapState): void { this.bootstrap = state; this.broadcast() }

  private assertSender(event: IpcMainInvokeEvent): void {
    if (event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame
      || event.senderFrame.url !== pathToFileURL(join(app.getAppPath(), 'index.html')).href) throw new Error('Untrusted desktop sender')
  }

  private broadcast(): void {
    if (this.window.isDestroyed()) return
    this.window.webContents.send('mcp-proxy:bootstrap', this.bootstrap)
    if (this.snapshot !== undefined) this.window.webContents.send('mcp-proxy:snapshot', this.snapshot)
    this.updateTray()
  }

  private updateTray(): void {
    const rows = (this.snapshot?.servers ?? []).map(server => ({ label: `${server.origin} — ${this.t(server.state)}`, click: () => { this.show() } }))
    this.tray.setToolTip(this.t('brand'))
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: this.t('show'), click: () => { this.show() } }, { type: 'separator' },
      ...(rows.length ? rows : [{ label: this.t('emptyConnections'), enabled: false }]), { type: 'separator' },
      { label: this.t('exit'), click: () => { void this.exit() } },
    ]))
  }
}
