/** Local connector application runtime mounted by a dsh profile. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { decodeFrame, proveProxyIdentity, ProxyIdentity, type ProxyChannel, type ProxyFrame } from '@j-show/mcp-proxy-protocol'
import { attachLocalProxy, LocalMcpPool, readMcpProxySettings, parseManagedMcpSettings, type McpProxySettings } from '@j-show/mcp-proxy-local'
import WebSocket from 'ws'
import { listenLocalControl, machineControlAddress, type LocalControlServer } from './control.ts'
import type {} from '@deepseek-ai/dsh-cmdline'
import { holdWindowsServiceJob } from './windows-process-job.ts'
import { ManagedSettingsStore } from './settings-store.ts'
import { ManagedLocalRuntime } from './managed-runtime.ts'
import { DesktopController } from './desktop-controller.ts'
import { openDshConnection } from './dsh-connection.ts'
import { pairDshDevice } from './device-client.ts'

/** Settings file read before connecting to any downstream MCP. */
export interface Config {
  /** Local MCP configuration filename. */
  readonly settingsFile: string
  /** Credential reference for the installation signing key. */
  readonly identityRef: string
  /** WebSocket upgrade path on the DSH deployment. */
  readonly upgradePath: string
  /** Maximum UTF-8 protocol frame size in bytes. */
  readonly maxFrameBytes: number
  /** Maximum retained invocation identities per channel and active shared invocation routes. */
  readonly maxInvocations: number
  /** Maximum pending channel requests. */
  readonly maxPending: number
  /** Downstream MCP discovery deadline in milliseconds. */
  readonly startupTimeoutMs: number
  /** Tool invocation deadline in milliseconds. */
  readonly callTimeoutMs: number
  /** Maximum configured local MCP services. */
  readonly maxServices: number
  /** Maximum discovery pages per MCP service. */
  readonly maxDiscoveryPages: number
  /** Maximum downstream client callbacks per invocation. */
  readonly maxClientRequests: number
  /** Maximum retained downstream request records. */
  readonly maxClientRequestRecords: number
  /** Private control exchange deadline in milliseconds. */
  readonly controlTimeoutMs: number
  /** Maximum concurrent private control connections. */
  readonly maxControlConnections: number
  /** Delay before reconnecting a DSH channel in milliseconds. */
  readonly reconnectDelayMs: number
  /** Heartbeat interval in milliseconds. */
  readonly heartbeatIntervalMs: number
  /** Heartbeat acknowledgement deadline in milliseconds. */
  readonly heartbeatTimeoutMs: number
  /** Downstream task cancellation cleanup budget in milliseconds. */
  readonly taskCancelTimeoutMs: number
  /** Windows Job descendant shutdown budget in milliseconds. */
  readonly processJobDrainTimeoutMs: number
  /** Windows Job shutdown observation interval in milliseconds. */
  readonly processJobPollMs: number
  /** Maximum configured DSH deployments. */
  readonly maxServers: number
  /** Maximum retained complete catalog revisions. */
  readonly maxCatalogRevisions: number
  /** Maximum catalog revision fingerprints retained per connection. */
  readonly maxCatalogHistory: number
  /** Maximum retained desktop activation records. */
  readonly maxActivations: number
  /** Completed activation deduplication lifetime in milliseconds. */
  readonly activationLifetimeMs: number
  /** Desktop activation connection deadline in milliseconds. */
  readonly desktopConnectTimeoutMs: number
  /** Desktop connection readiness observation interval in milliseconds. */
  readonly desktopConnectPollMs: number
  /** Desktop management exchange deadline in milliseconds. */
  readonly managementTimeoutMs: number
  /** Maximum private management request size in bytes. */
  readonly maxManagementRequestBytes: number
  /** Maximum private management response size in bytes. */
  readonly maxManagementResponseBytes: number
  /** HTTPS device pairing deadline in milliseconds. */
  readonly pairingTimeoutMs: number
  /** Maximum HTTPS pairing response size in bytes. */
  readonly maxPairingResponseBytes: number
}
declare module '@deepseek-ai/cordis' { interface Context { mcpProxyLocal: LocalProxyRuntime } }

/** Own the local application's MCP clients and outbound server connection. */
export default class LocalProxyRuntime extends Service {
  static inject = ['credentials', 'appExit']
  static Config: z<Config> = z.object({
    settingsFile: z.string().required(), identityRef: z.string().default('MCP_PROXY_INSTALLATION_KEY'),
    upgradePath: z.string().default('/mcp-proxy/connect'),
    maxFrameBytes: z.natural().min(1).default(1048576), maxInvocations: z.natural().min(1).default(4096),
    maxPending: z.natural().min(1).default(32), maxServices: z.natural().min(1).default(32),
    maxDiscoveryPages: z.natural().min(1).default(64), maxClientRequests: z.natural().min(1).default(32),
    maxClientRequestRecords: z.natural().min(1).default(4096),
    controlTimeoutMs: z.natural().min(1).max(2147483647).default(5000),
    maxControlConnections: z.natural().min(1).default(16),
    reconnectDelayMs: z.natural().min(1).max(2147483647).default(1000),
    heartbeatIntervalMs: z.natural().min(1).max(2147483647).default(15000),
    heartbeatTimeoutMs: z.natural().min(1).max(2147483647).default(10000),
    taskCancelTimeoutMs: z.natural().min(1).max(2147483647).default(5000),
    processJobDrainTimeoutMs: z.natural().min(1).max(2147483647).default(1000),
    processJobPollMs: z.natural().min(1).max(2147483647).default(10),
    startupTimeoutMs: z.natural().min(1).max(2147483647).default(10000),
    callTimeoutMs: z.natural().min(1).max(2147483647).default(60000),
    maxServers: z.natural().min(1).default(64),
    maxCatalogRevisions: z.natural().min(1).default(64),
    maxCatalogHistory: z.natural().min(1).default(4096),
    maxActivations: z.natural().min(1).default(4096),
    activationLifetimeMs: z.natural().min(1).max(2147483647).default(60000),
    desktopConnectTimeoutMs: z.natural().min(1).max(2147483647).default(30000),
    desktopConnectPollMs: z.natural().min(1).max(2147483647).default(100),
    managementTimeoutMs: z.natural().min(1).max(2147483647).default(60000),
    maxManagementRequestBytes: z.natural().min(1).default(1048576),
    maxManagementResponseBytes: z.natural().min(1).default(1048576),
    pairingTimeoutMs: z.natural().min(1).max(2147483647).default(10000),
    maxPairingResponseBytes: z.natural().min(1).default(8192),
  })
  private readonly config: Config
  private pool: LocalMcpPool | undefined
  private socket: WebSocket | undefined
  private channel: ProxyChannel | undefined
  private acknowledged = false
  private closed = false
  private proof: Promise<unknown> | undefined
  private starting: Promise<void> | undefined
  private reconnecting: Promise<void> | undefined
  private connectionClosed: Promise<void> | undefined
  private readonly stop = new AbortController()
  private control: LocalControlServer | undefined
  private managed: ManagedLocalRuntime | undefined
  private desktop: DesktopController | undefined
  private processJob: ReturnType<typeof holdWindowsServiceJob> | undefined
  private startupStage: 'configuration' | 'credentials' | 'local-control' | 'process-containment'
    | 'installation-identity' | 'tls-settings' | 'local-mcp' | 'server-admission' = 'configuration'
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mcpProxyLocal')
    this.config = LocalProxyRuntime.Config(config)
    credentialRef(this.config.identityRef)
    if (!/^\/[A-Za-z0-9/_-]+$/.test(this.config.upgradePath)) throw new Error('Invalid local MCP proxy upgrade path')
  }
  /** Whether server admission and catalog acknowledgement have both completed. */
  get connected(): boolean {
    if (this.managed !== undefined) return this.managed.connected
    return !this.closed && this.acknowledged && this.pool?.available === true && this.socket?.readyState === WebSocket.OPEN
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => {
      this.closed = true
      this.stop.abort()
      this.socket?.terminate()
      await this.starting?.catch((_error: unknown) => {
        // Startup reports its own fixed failure; disposal still drains acquired resources.
      })
      await this.reconnecting
      try {
        try { await this.desktop?.close() } finally { await this.managed?.close() }
        await this.proof
        await this.channel?.close()
      } finally {
        try { await this.pool?.close() } finally { await this.control?.close() }
        await this.processJob?.release({ timeoutMs: this.config.processJobDrainTimeoutMs, pollIntervalMs: this.config.processJobPollMs })
      }
    }
    this.starting = this.start()
    await this.starting
  }

  private checkOpen(): void {
    if (this.closed) throw new Error('Local MCP proxy runtime is closed')
  }

  private async start(): Promise<void> {
    try { await this.connect() } catch (_error) {
      // Provider and TLS errors can contain private paths or credential material.
      process.stderr.write(`mcp-proxy: ${this.startupStage} failed\n`)
      this.ctx.get('appExit')?.(1)
      throw new Error('Local MCP proxy startup failed')
    }
  }

  private async connect(): Promise<void> {
    if (this.ctx.get('mcpProxyStartup')?.managed === true) { await this.connectManaged(); return }
    const settings = await readMcpProxySettings(this.config.settingsFile)
    this.checkOpen()
    this.startupStage = 'credentials'
    const secret = await this.ctx.credentials.resolve(credentialRef(settings.server.credentialRef))
    this.checkOpen()
    if (secret === undefined) throw new Error('MCP proxy deployment credential is not configured')
    this.startupStage = 'local-control'
    const address = await machineControlAddress()
    this.checkOpen()
    const exit = this.ctx.get('appExit')
    if (exit === undefined) throw new Error('Local MCP proxy requires a dsh launcher exit service')
    this.control = await listenLocalControl(address, {
      timeoutMs: this.config.controlTimeoutMs, maxConnections: this.config.maxControlConnections,
    }, request => this.associate(request), () => { exit(0) }, () => this.connected)
    this.checkOpen()
    this.startupStage = 'process-containment'
    if (process.platform === 'win32') this.processJob = holdWindowsServiceJob()
    this.startupStage = 'installation-identity'
    const ref = credentialRef(this.config.identityRef)
    const existing = await this.ctx.credentials.resolve(ref)
    this.checkOpen()
    const identity = existing === undefined ? ProxyIdentity.generate() : ProxyIdentity.restore(existing.value)
    if (existing === undefined) await this.ctx.credentials.set(ref, identity.exportPrivateKey())
    this.checkOpen()
    this.startupStage = 'tls-settings'
    const ca = settings.server.caFile === undefined ? undefined : await readFile(settings.server.caFile)
    this.checkOpen()
    const options = this.config
    this.startupStage = 'local-mcp'
    this.pool = await LocalMcpPool.open(settings.services, {
      maxServices: options.maxServices, maxFrameBytes: options.maxFrameBytes, maxDiscoveryPages: options.maxDiscoveryPages,
      startupTimeoutMs: options.startupTimeoutMs, callTimeoutMs: options.callTimeoutMs,
      maxClientRequests: options.maxClientRequests, maxClientRequestRecords: options.maxClientRequestRecords,
      taskCancelTimeoutMs: options.taskCancelTimeoutMs,
    }, async (request) => {
      const channel = this.channel
      if (channel === undefined || !this.connected) throw new Error('Local MCP callback connection unavailable')
      return channel.callback(request.invocationId, request.method, request.params, options.callTimeoutMs, request.signal)
    }, { signal: this.stop.signal, excludeEnvironment: [settings.server.credentialRef, this.config.identityRef] })
    this.checkOpen()
    const pool = this.pool
    const catalog = await pool.catalog()
    this.checkOpen()
    this.startupStage = 'server-admission'
    await this.openConnection(settings, identity, secret.value, ca, pool, catalog)
    const connect = async () => {
      const refreshed = await pool.recover(this.stop.signal)
      this.checkOpen()
      await this.openConnection(settings, identity, secret.value, ca, pool, refreshed)
    }
    this.reconnecting = this.maintainConnection(connect)
  }

  private async connectManaged(): Promise<void> {
    const options = this.config
    const parsed = parseManagedMcpSettings(JSON.parse(await readFile(options.settingsFile, 'utf8')) as unknown, dirname(options.settingsFile))
    this.checkOpen()
    this.startupStage = 'local-control'
    const exit = this.ctx.get('appExit')
    if (exit === undefined) throw new Error('Local MCP proxy requires a dsh launcher exit service')
    this.control = await listenLocalControl(await machineControlAddress(), {
      timeoutMs: options.managementTimeoutMs, maxConnections: options.maxControlConnections,
    }, async (requestId) => {
      if (this.desktop === undefined) throw new Error('Local desktop is not ready')
      const reply = await this.desktop.handle({ kind: 'activate', uri: `mcp-proxy://associate/${requestId}` })
      if (!reply.ok) throw new Error('Local desktop activation unavailable')
    }, () => { exit(0) }, () => this.desktop !== undefined, {
      maxRequestBytes: options.maxManagementRequestBytes, maxResponseBytes: options.maxManagementResponseBytes,
      handle: async (request) => {
        if (this.desktop === undefined) throw new Error('Local desktop is not ready')
        return await this.desktop.handle(request)
      },
    })
    this.checkOpen()
    this.startupStage = 'process-containment'
    if (process.platform === 'win32') this.processJob = holdWindowsServiceJob()
    const store = await ManagedSettingsStore.open({ filename: options.settingsFile, directory: parsed.directory,
      identityFile: parsed.identityFile, legacyIdentityRef: options.identityRef, waitMs: options.controlTimeoutMs })
    this.startupStage = 'local-mcp'
    this.managed = await ManagedLocalRuntime.open(store, { pool: {
      maxServices: options.maxServices, maxFrameBytes: options.maxFrameBytes, maxDiscoveryPages: options.maxDiscoveryPages,
      maxClientRequests: options.maxClientRequests, maxClientRequestRecords: options.maxClientRequestRecords,
      startupTimeoutMs: options.startupTimeoutMs, callTimeoutMs: options.callTimeoutMs, taskCancelTimeoutMs: options.taskCancelTimeoutMs,
    }, maxServers: options.maxServers,
    maxInvocations: options.maxInvocations, reconnectDelayMs: options.reconnectDelayMs },
    async (server, context) => openDshConnection(server, context, this.ctx.credentials, {
      ...options, heartbeat: { intervalMs: options.heartbeatIntervalMs, timeoutMs: options.heartbeatTimeoutMs },
    }), this.stop.signal)
    this.checkOpen()
    this.desktop = new DesktopController(store, this.managed,
      async (activation, signal, ca, previous) => pairDshDevice(activation, this.ctx.credentials,
        { timeoutMs: options.pairingTimeoutMs, maxResponseBytes: options.maxPairingResponseBytes }, signal, ca, previous),
      { maxActivations: options.maxActivations, activationLifetimeMs: options.activationLifetimeMs,
        connectTimeoutMs: options.desktopConnectTimeoutMs, connectPollMs: options.desktopConnectPollMs }, this.stop.signal)
  }

  private async maintainConnection(connect: () => Promise<void>): Promise<void> {
    await this.connectionClosed
    while (!this.closed) {
      try {
        await this.channel?.close()
        await this.proof
        await delay(this.config.reconnectDelayMs, undefined, { signal: this.stop.signal })
        this.checkOpen()
        await connect()
        await this.connectionClosed
      } catch (_error) {
        // Reconnects replace only the transport; local processes and installation identity stay owned here.
        this.socket?.terminate()
        await this.connectionClosed
      }
    }
  }

  private async openConnection(
    settings: McpProxySettings, identity: ProxyIdentity, secret: string, ca: Buffer | undefined,
    pool: LocalMcpPool, catalog: Extract<ProxyFrame, { kind: 'catalog' }>,
  ): Promise<void> {
    this.checkOpen()
    const options = this.config
    const ready = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const socket = new WebSocket(settings.server.origin.replace('https:', 'wss:') + options.upgradePath, {
      headers: { Authorization: `Bearer ${secret}` }, maxPayload: options.maxFrameBytes,
      handshakeTimeout: options.startupTimeoutMs, perMessageDeflate: false, ...(ca === undefined ? {} : { ca }),
    })
    this.socket = socket
    this.connectionClosed = closed.promise
    const failed = (): void => {
      this.acknowledged = false
      ready.reject(new Error('Local MCP proxy server connection unavailable'))
    }
    socket.on('error', () => { failed(); socket.terminate() })
    socket.on('close', () => { failed(); closed.resolve() })
    const timer = setTimeout(() => { failed(); socket.terminate() }, options.startupTimeoutMs)
    timer.unref()
    socket.once('open', () => {
      this.proof = proveProxyIdentity(socket, identity, settings.server.origin, {
        timeoutMs: options.startupTimeoutMs, maxFrameBytes: options.maxFrameBytes,
      }, (peer) => {
        this.channel = attachLocalProxy(socket, peer, pool, catalog, { ...options,
          heartbeat: { intervalMs: options.heartbeatIntervalMs, timeoutMs: options.heartbeatTimeoutMs },
        })
        socket.on('message', (data, binary) => {
          try {
            if (!pool.available) { failed(); socket.terminate(); return }
            if (binary) throw new Error('Text control frames required')
            const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
            const frame = decodeFrame(bytes.toString(), options.maxFrameBytes)
            if (frame.kind === 'catalog-accepted' && frame.revision === catalog.revision) {
              this.acknowledged = true
              ready.resolve()
            } else if (frame.kind === 'catalog-rejected') { failed(); socket.terminate() }
          } catch (_error) {
            // Invalid server control data cannot establish a ready runtime.
            failed(); socket.terminate()
          }
        })
        void this.send(catalog).catch(() => { failed(); socket.terminate() })
      }).catch((_error: unknown) => { failed(); socket.terminate() })
    })
    try { await ready.promise } finally { clearTimeout(timer) }
  }

  /**
   * Forward an opaque browser transaction over this installation's authenticated channel.
   * @param requestId - URI transaction; never a server address or tool instruction.
   * @returns completion of the socket write, not browser association confirmation.
   */
  async associate(requestId: string): Promise<void> {
    if (!this.connected) throw new Error('Local MCP proxy server connection unavailable')
    await this.send(decodeFrame(JSON.stringify({ v: 1, kind: 'association', requestId }), this.config.maxFrameBytes))
  }

  private send(frame: ProxyFrame): Promise<void> {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Local MCP proxy socket unavailable'))
    return new Promise((resolve, reject) => {
      socket.send(JSON.stringify(frame), (error) => { if (error) reject(new Error('Local MCP proxy write failed')); else resolve() })
    })
  }
}
