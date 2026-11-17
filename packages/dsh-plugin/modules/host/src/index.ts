/** Harness-side local MCP registration plugin. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { acceptProxyIdentity, AssociationStore, decodeFrame, ProxyCallError, ProxyChannel, catalogFingerprint,
  type AuthenticatedProxy, type EndpointId, type GenerationId, type ProxyFrame, type ProxyInvocationRequest, type ProxyCallbackHandler,
  type AssociationRequest, type AssociationRequestId, type BrowserBindingId,
} from '@jshow/app-mcp-proxy/protocol'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { ProxyAdmissions } from './admissions.ts'
import { ElicitationStore } from './elicitation.ts'
import { DeviceRegistry } from './devices.ts'
import { DevicePairing } from './pairing.ts'

export { promptAdmissionId } from './admissions.ts'
export type { PromptAdmissionId } from './admissions.ts'
export type { PendingElicitation, ElicitationId } from './elicitation.ts'

/** Catalog received from one local connector. */
export type ProxyCatalog = Extract<ProxyFrame, { kind: 'catalog' }>
/** Exact connection and catalog selected for a Turn. */
export interface ProxySelection { readonly endpointId: EndpointId; readonly generation: GenerationId; readonly catalog: ProxyCatalog }
declare module '@deepseek-ai/cordis' {
  interface Context { mcpProxy: McpProxyHost }
}

/** Deployment origin, credential reference and resource limits for local connector admission. */
export interface Config {
  /** Canonical public HTTPS origin used for device proof and admission. */
  readonly publicOrigin: string
  /** Credential reference required for legacy connector admission. */
  readonly credentialRef?: string
  /** Explicit connector admission mode: legacy deployment credential, registered device, or both. */
  readonly admission: 'legacy' | 'device' | 'both'
  /** Durable device registry filename required for device admission. */
  readonly deviceRegistryFile?: string
  /** Maximum registered device records, including revoked devices. */
  readonly maxDevices: number
  /** Maximum durable device registry size in bytes. */
  readonly maxDeviceRegistryBytes: number
  /** Device registry publication lock wait budget in milliseconds. */
  readonly deviceRegistryLockTimeoutMs: number
  /** Maximum concurrent HTTPS ticket redemption requests. */
  readonly maxPairingRequests: number
  /** Maximum HTTPS pairing request body size in bytes. */
  readonly maxPairingRequestBytes: number
  /** HTTPS ticket redemption request deadline in milliseconds. */
  readonly pairingRequestTimeoutMs: number
  /** WebSocket upgrade path on the DSH deployment. */
  readonly upgradePath: string
  /** Maximum admitted local connector connections. */
  readonly maxConnections: number
  /** Maximum UTF-8 protocol frame size in bytes. */
  readonly maxFrameBytes: number
  /** Connector possession-proof deadline in milliseconds. */
  readonly handshakeTimeoutMs: number
  /** Tool invocation deadline in milliseconds. */
  readonly callTimeoutMs: number
  /** Maximum invocation identities retained per connection generation, including terminal outcomes. */
  readonly maxInvocations: number
  /** Maximum pending channel requests. */
  readonly maxPending: number
  /** Maximum retained complete catalog revisions. */
  readonly maxCatalogRevisions: number
  /** Maximum catalog revision fingerprints retained per connection. */
  readonly maxCatalogHistory: number
  /** Maximum pending browser association operations. */
  readonly associationCapacity: number
  /** Unconsumed browser association ticket lifetime in milliseconds. */
  readonly associationChallengeLifetimeMs: number
  /** Established browser association grant lifetime in milliseconds. */
  readonly associationGrantLifetimeMs: number
  /** Heartbeat interval in milliseconds. */
  readonly heartbeatIntervalMs: number
  /** Heartbeat acknowledgement deadline in milliseconds. */
  readonly heartbeatTimeoutMs: number
  /** Maximum pending invocation-owned human requests. */
  readonly maxPendingElicitations: number
  /** Human request deadline in milliseconds. */
  readonly elicitationLifetimeMs: number
  /** Maximum serialized human request size in bytes. */
  readonly maxElicitationBytes: number
}

interface Connection {
  readonly admission: 'legacy' | 'device'
  readonly peer: AuthenticatedProxy
  readonly socket: WebSocket
  readonly channel: ProxyChannel
  readonly catalogs: Map<string, ProxyCatalog>
  readonly catalogHistory: Map<string, string>
  catalog?: ProxyCatalog
}

function refuse(socket: Duplex, status: 401 | 503): void {
  const response = `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  socket.end(response, () => { socket.destroy() })
}

function digest(value: string): Buffer { return createHash('sha256').update(value).digest() }

/** Host registry; construction does not launch a separate application. */
export default class McpProxyHost extends Service {
  static inject = ['webServer', 'credentials']
  static Config: z<Config> = z.object({
    publicOrigin: z.string().required(),
    credentialRef: z.string(),
    admission: z.union(['legacy', 'device', 'both']).default('legacy'),
    deviceRegistryFile: z.string(),
    maxDevices: z.natural().min(1).default(4096),
    maxDeviceRegistryBytes: z.natural().min(1).default(4194304),
    deviceRegistryLockTimeoutMs: z.natural().min(1).max(2147483647).default(5000),
    maxPairingRequests: z.natural().min(1).default(16),
    maxPairingRequestBytes: z.natural().min(1).default(8192),
    pairingRequestTimeoutMs: z.natural().min(1).max(2147483647).default(10000),
    upgradePath: z.string().default('/mcp-proxy/connect'),
    maxConnections: z.natural().min(1).default(64),
    maxFrameBytes: z.natural().min(1).default(1048576),
    handshakeTimeoutMs: z.natural().min(1).max(2147483647).default(10000),
    callTimeoutMs: z.natural().min(1).max(2147483647).default(60000),
    maxInvocations: z.natural().min(1).default(4096),
    maxPending: z.natural().min(1).default(32),
    maxCatalogRevisions: z.natural().min(1).default(64),
    maxCatalogHistory: z.natural().min(1).default(4096),
    associationCapacity: z.natural().min(1).default(4096),
    associationChallengeLifetimeMs: z.natural().min(1).max(2147483647).default(30000),
    associationGrantLifetimeMs: z.natural().min(1).max(2147483647).default(600000),
    heartbeatIntervalMs: z.natural().min(1).max(2147483647).default(15000),
    heartbeatTimeoutMs: z.natural().min(1).max(2147483647).default(10000),
    maxPendingElicitations: z.natural().min(1).max(2147483647).default(64),
    elicitationLifetimeMs: z.natural().min(1).max(2147483647).default(600000),
    maxElicitationBytes: z.natural().min(1).max(2147483647).default(32768),
  })
  private readonly config: Config
  private devices: DeviceRegistry | undefined
  private pairing: DevicePairing | undefined
  private readonly stop = new AbortController()
  private pairingRequests = 0
  private associationPending = 0
  private associationTail: Promise<void> = Promise.resolve()
  private readonly server: WebSocketServer
  private readonly entries = new Map<EndpointId, Connection>()
  private readonly work = new Set<Promise<void>>()
  private readonly rawSockets = new Set<Duplex>()
  private closed = false
  /** Deployment-local transactions; only the authenticated connector receiver confirms endpoint identities. */
  readonly associations: AssociationStore
  /** One-use browser authority consumed by accepted input listeners during their initiating Web request. */
  readonly admissions: ProxyAdmissions = new ProxyAdmissions()
  /** Invocation-owned human waits; page requests only inspect or answer an existing wait. */
  readonly elicitations: ElicitationStore

  constructor(ctx: Context, config: Config) {
    super(ctx, 'mcpProxy')
    this.config = McpProxyHost.Config(config)
    if (this.config.maxCatalogHistory < this.config.maxCatalogRevisions) throw new Error('Catalog history must cover retained catalogs')
    this.elicitations = new ElicitationStore({ maxPending: this.config.maxPendingElicitations,
      lifetimeMs: this.config.elicitationLifetimeMs, maxRequestBytes: this.config.maxElicitationBytes,
    })
    this.associations = new AssociationStore({ capacity: this.config.associationCapacity,
      challengeLifetimeMs: this.config.associationChallengeLifetimeMs, grantLifetimeMs: this.config.associationGrantLifetimeMs,
    }, Date.now)
    const origin = new URL(this.config.publicOrigin)
    if (origin.protocol !== 'https:' || origin.origin !== this.config.publicOrigin) throw new Error('MCP proxy publicOrigin must be a canonical HTTPS origin')
    if (!/^\/[A-Za-z0-9/_-]+$/.test(this.config.upgradePath)) throw new Error('MCP proxy upgradePath must be an absolute pathname')
    if (this.config.admission !== 'device' && this.config.credentialRef === undefined) throw new Error('Legacy MCP admission requires a credential reference')
    if (this.config.admission !== 'legacy' && this.config.deviceRegistryFile === undefined) throw new Error('Device MCP admission requires a registry file')
    if (this.config.credentialRef !== undefined) credentialRef(this.config.credentialRef)
    this.server = new WebSocketServer({ noServer: true, maxPayload: this.config.maxFrameBytes, perMessageDeflate: false })
  }

  /** Canonical HTTPS origin used for connector proofs and browser association cookies. */
  get publicOrigin(): string { return this.config.publicOrigin }

  /** Whether first-origin pairing is enabled and its durable authority has loaded. */
  get pairingEnabled(): boolean { return this.pairing !== undefined }

  /**
   * Issue a browser-bound association and optional device-pairing ticket.
   * @param browser - authenticated initiating browser.
   * @returns the short-lived association request.
   */
  beginAssociation(browser: BrowserBindingId): AssociationRequest {
    const request = this.associations.begin(browser)
    this.pairing?.issue(request)
    return request
  }

  /**
   * Serialize browser association and device redemption against this deployment.
   * @param operation - browser association or device redemption operation.
   * @returns its serialized result.
   */
  associationTransaction<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed || this.associationPending >= this.config.associationCapacity) return Promise.reject(new Error('Association unavailable'))
    this.associationPending++
    const result = this.associationTail.then(async () => {
      if (this.closed) throw new Error('Association unavailable')
      return await operation()
    })
    this.associationTail = result.then(() => {}, () => {})
    return result.finally(() => { this.associationPending-- })
  }

  async* [Service.init](): AsyncGenerator<() => void | Promise<void>, void, void> {
    yield async () => {
      this.closed = true
      this.stop.abort()
      this.elicitations.close()
      for (const socket of this.rawSockets) socket.destroy()
      const channels = [...this.entries.values()].map(entry => entry.channel.close())
      for (const socket of this.server.clients) socket.terminate()
      await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
      await Promise.all(channels)
      await this.associationTail
      while (this.work.size > 0) await Promise.all(this.work)
      this.entries.clear()
    }
    if (this.config.admission !== 'device') {
      const ref = this.config.credentialRef
      if (ref === undefined || await this.ctx.credentials.resolve(credentialRef(ref)) === undefined) {
        throw new Error('MCP proxy deployment credential is not configured')
      }
    }
    if (this.config.admission !== 'legacy') {
      const filename = this.config.deviceRegistryFile
      if (filename === undefined) throw new Error('MCP device registry file is required')
      this.devices = await DeviceRegistry.open({ filename, origin: this.config.publicOrigin, maxDevices: this.config.maxDevices,
        maxBytes: this.config.maxDeviceRegistryBytes, lockTimeoutMs: this.config.deviceRegistryLockTimeoutMs })
      this.pairing = new DevicePairing({ origin: this.config.publicOrigin, capacity: this.config.associationCapacity,
        maxFrameBytes: this.config.maxFrameBytes }, this.devices, Date.now, (id) =>{  this.associations.assertPending(id) })
      yield this.ctx.webServer.register({ kind: 'exact', path: '/mcp-proxy/pair', handler: async (request, response) => {
        const operation = this.redeemDevice(request, response)
        this.work.add(operation)
        try { await operation } finally { this.work.delete(operation) }
      } })
    }
    yield this.ctx.webServer.registerUpgrade({ path: this.config.upgradePath, handler: async (request, socket, head) => {
      const operation = this.upgrade(request, socket, head)
      this.work.add(operation)
      try { await operation } finally { this.work.delete(operation) }
    } })
  }

  private async redeemDevice(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed || this.pairingRequests >= this.config.maxPairingRequests) { response.writeHead(503); response.end(); return }
    this.pairingRequests++
    const interrupted = new AbortController()
    const abort = (): void => { interrupted.abort(); request.destroy() }
    this.stop.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, this.config.pairingRequestTimeoutMs)
    timer.unref()
    try {
      if (request.method !== 'POST' || request.url !== '/mcp-proxy/pair'
        || request.headers.host !== new URL(this.config.publicOrigin).host
        || (request.headers.origin !== undefined && request.headers.origin !== this.config.publicOrigin)) throw new Error('Invalid pairing request')
      const chunks: Buffer[] = []
      let size = 0
      for await (const part of request) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array)
        size += bytes.length
        if (size > this.config.maxPairingRequestBytes) throw new Error('Pairing request too large')
        chunks.push(bytes)
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof value !== 'object' || value === null || Object.keys(value).length !== 2
        || !('requestId' in value) || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.requestId)
        || !('registration' in value)) throw new Error('Invalid pairing request')
      const requestId = value.requestId as AssociationRequestId
      const registration = value.registration
      const endpointId = await this.associationTransaction(async () => {
        if (this.pairing === undefined) throw new Error('Pairing unavailable')
        return await this.pairing.redeem(requestId, registration)
      })
      if (this.stop.signal.aborted || interrupted.signal.aborted || response.destroyed) return
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ endpointId, upgradePath: this.config.upgradePath }))
    } catch (_error) {
      // Pairing tickets, public proof bodies and credential diagnostics are not returned or logged.
      if (!response.destroyed) { response.writeHead(409, { 'cache-control': 'no-store' }); response.end() }
    } finally {
      clearTimeout(timer)
      this.stop.signal.removeEventListener('abort', abort)
      this.pairingRequests--
    }
  }

  /**
   * Select the live connection and its immutable catalog.
   * @param endpoint - verified endpoint.
   * @returns the current selection, or undefined when unavailable.
   */
  select(endpoint: EndpointId): ProxySelection | undefined {
    const entry = this.entries.get(endpoint)
    if (entry?.catalog === undefined || entry.socket.readyState !== WebSocket.OPEN) return undefined
    return { ...entry.peer, catalog: structuredClone(entry.catalog) }
  }

  /**
   * Invoke the exact tool pinned to the selected connection and catalog.
   * @param selection - pinned generation.
   * @param request - exact selected tool.
   * @param signal - caller cancellation.
   * @param handler - this tool invocation's model/human callback owner.
   * @returns raw MCP result.
   */
  async invoke(selection: ProxySelection, request: ProxyInvocationRequest, signal?: AbortSignal,
    handler?: ProxyCallbackHandler): Promise<Extract<ProxyFrame, { kind: 'result' }>['result']> {
    const entry = this.entries.get(selection.endpointId)
    const retained = entry?.catalogs.get(request.revision)
    const tool = retained?.tools.find(tool => tool.service === request.service && tool.name === request.name)
    const currentTool = entry?.catalog?.tools.find(tool => tool.service === request.service && tool.name === request.name)
    const incarnation = retained?.services.find(service => service.service === request.service)?.incarnation
    const currentIncarnation = entry?.catalog?.services.find(service => service.service === request.service)?.incarnation
    if (this.closed || entry === undefined || entry.peer.generation !== selection.generation
      || retained === undefined || selection.catalog.revision !== request.revision || tool === undefined
      || !isDeepStrictEqual(tool, currentTool)
      || (entry.catalog?.revision !== request.revision && (incarnation === undefined || incarnation !== currentIncarnation))) {
      throw new ProxyCallError('unavailable', 'Selected local MCP tool is unavailable')
    }
    return entry.channel.invoke(request, this.config.callTimeoutMs, signal, handler)
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const released = (): void => { this.rawSockets.delete(socket) }
    this.rawSockets.add(socket)
    socket.once('close', released)
    if (this.closed || this.server.clients.size + this.rawSockets.size > this.config.maxConnections) { refuse(socket, 503); return }
    try {
      const expectedHost = new URL(this.config.publicOrigin).host
      const origin = request.headers.origin
      const authorization = request.headers.authorization
      if (authorization === undefined || request.headers.host !== expectedHost
        || (origin !== undefined && origin !== this.config.publicOrigin)
        || request.url !== this.config.upgradePath) { refuse(socket, 401); return }
      let admission: 'legacy' | 'device'
      let expectedDevice: EndpointId | undefined
      if (authorization.startsWith('Device ') && this.config.admission !== 'legacy' && this.devices !== undefined) {
        const endpoint = authorization.slice(7)
        if (!/^[a-f0-9]{64}$/.test(endpoint)) { refuse(socket, 401); return }
        await this.devices.refresh()
        if (!this.devices.allows(endpoint as EndpointId)) { refuse(socket, 401); return }
        expectedDevice = endpoint as EndpointId
        admission = 'device'
      } else {
        const ref = this.config.credentialRef
        if (this.config.admission === 'device' || ref === undefined) { refuse(socket, 401); return }
        const resolved = await this.ctx.credentials.resolve(credentialRef(ref))
        if (resolved === undefined || !timingSafeEqual(digest(authorization), digest(`Bearer ${resolved.value}`))) {
          refuse(socket, 401); return
        }
        admission = 'legacy'
      }
      if (this.stop.signal.aborted) { refuse(socket, 503); return }
      if (socket.destroyed) return
      this.server.handleUpgrade(request, socket, head, (peerSocket) => {
        this.rawSockets.delete(socket)
        socket.off('close', released)
        peerSocket.on('error', () => { /* The channel or handshake owns rejection and cleanup; raw socket errors stay private. */ })
        const operation = acceptProxyIdentity(peerSocket, this.config.publicOrigin, {
          maxFrameBytes: this.config.maxFrameBytes, timeoutMs: this.config.handshakeTimeoutMs,
        }, (peer) => {
          if (expectedDevice !== undefined && (peer.endpointId !== expectedDevice || !this.devices?.allows(expectedDevice))) {
            throw new Error('Device proof does not match registered authority')
          }
          this.attach(peerSocket, peer, admission)
        }).then(() => {}, () => {})
        this.work.add(operation)
        void operation.then(() => { this.work.delete(operation) })
      })
    } catch (_error) {
      // Credential-provider and upgrade errors can contain secrets; reject with a fixed HTTP status.
      refuse(socket, 503)
    }
  }

  private attach(socket: WebSocket, peer: AuthenticatedProxy, admission: 'legacy' | 'device'): void {
    if (this.closed || this.entries.has(peer.endpointId)) throw new Error('MCP proxy endpoint already connected')
    const channel = new ProxyChannel(socket, { generation: peer.generation, maxFrameBytes: this.config.maxFrameBytes,
      maxInvocations: this.config.maxInvocations, maxPending: this.config.maxPending,
      heartbeat: { intervalMs: this.config.heartbeatIntervalMs, timeoutMs: this.config.heartbeatTimeoutMs },
    })
    const entry: Connection = { peer, socket, channel, catalogs: new Map(), catalogHistory: new Map(), admission }
    this.entries.set(peer.endpointId, entry)
    const receive = (data: RawData, binary: boolean): void => {
      try {
        if (binary) throw new Error('Text frames required')
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
        const frame = decodeFrame(bytes.toString(), this.config.maxFrameBytes)
        if (frame.kind === 'catalog') this.publish(entry, frame)
        else if (frame.kind === 'association' && entry.catalog !== undefined) {
          const operation = this.associationTransaction(() => {
            if (entry.admission === 'device' && !this.pairing?.owns(frame.requestId, peer.endpointId)) throw new Error('Device did not redeem this ticket')
            this.associations.confirm(frame.requestId, peer.endpointId)
          }).then(() => {}, () => {
            // Expired or repeated URI activations cannot replace another association.
          })
          this.work.add(operation)
          void operation.then(() => { this.work.delete(operation) })
        }
      } catch (_error) {
        // Invalid peer control data cannot update the registry.
        socket.terminate()
      }
    }
    socket.on('message', receive)
    socket.once('close', () => {
      socket.off('message', receive)
      if (this.entries.get(peer.endpointId) === entry) this.entries.delete(peer.endpointId)
      const closing = channel.close()
      this.work.add(closing)
      void closing.then(() => { this.work.delete(closing) })
    })
  }

  private publish(entry: Connection, catalog: ProxyCatalog): void {
    const previous = entry.catalogs.get(catalog.revision)
    const fingerprint = catalogFingerprint(catalog)
    const remembered = entry.catalogHistory.get(catalog.revision)
    if (previous !== undefined && !isDeepStrictEqual(previous, catalog)) {
      this.send(entry.socket, { v: 1, kind: 'catalog-rejected', revision: catalog.revision, code: 'conflict' })
      return
    }
    if (previous === undefined && (remembered !== undefined || entry.catalogHistory.size >= this.config.maxCatalogHistory)) {
      this.send(entry.socket, { v: 1, kind: 'catalog-rejected', revision: catalog.revision,
        code: remembered !== undefined && remembered !== fingerprint ? 'conflict' : 'unavailable' })
      return
    }
    if (previous === undefined && entry.catalogs.size >= this.config.maxCatalogRevisions) {
      const oldest = entry.catalogs.keys().next().value
      if (oldest !== undefined) entry.catalogs.delete(oldest)
    }
    entry.catalogHistory.set(catalog.revision, fingerprint)
    entry.catalogs.set(catalog.revision, catalog)
    entry.catalog = catalog
    this.send(entry.socket, { v: 1, kind: 'catalog-accepted', revision: catalog.revision })
  }

  private send(socket: WebSocket, frame: ProxyFrame): void {
    const payload = JSON.stringify(frame)
    if (Buffer.byteLength(payload) > this.config.maxFrameBytes) { socket.terminate(); return }
    if (socket.readyState === WebSocket.OPEN) socket.send(payload, (error) => { if (error) socket.terminate() })
  }
}
