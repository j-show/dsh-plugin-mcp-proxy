/** TLS and identity admission for one independently owned DSH socket. */
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { attachLocalProxy, type LocalDshSettings } from '@jshow/app-mcp-proxy/local'
import { ProxyIdentity, proveProxyIdentity, catalogFingerprint, decodeFrame,
  type ChannelOptions, type ProxyFrame, type ProxyChannel, type CatalogRevision,
  type AssociationRequestId, type AuthenticatedProxy } from '@jshow/app-mcp-proxy/protocol'
import { readFile } from 'node:fs/promises'
import WebSocket from 'ws'
import type { ManagedDshChannel, ManagedDshContext } from './managed-runtime.ts'

/** Explicit socket, catalog retention and request budgets. */
export interface DshConnectionOptions extends Omit<ChannelOptions, 'generation' | 'onInvoke'> {
  readonly upgradePath: string
  readonly startupTimeoutMs: number
  readonly callTimeoutMs: number
  readonly maxCatalogRevisions: number
  readonly maxCatalogHistory: number
}

/**
 * Authenticate a DSH connection and publish the shared MCP catalog.
 * @param server - registered persistent DSH entry.
 * @param context - shared pool and original channel lifetime.
 * @param credentials - profile-owned credential provider.
 * @param options - resolved connection budgets.
 * @returns authenticated, catalog-acknowledged channel; failed startup releases the same socket.
 */
export async function openDshConnection(server: LocalDshSettings, context: ManagedDshContext,
  credentials: CredentialProvider, options: DshConnectionOptions): Promise<ManagedDshChannel> {
  context.signal.throwIfAborted()
  const existing = await credentials.resolve(credentialRef(server.identityRef))
  if (existing === undefined && server.mode === 'device') throw new Error('DSH device identity is unavailable; pair again')
  const identity = existing === undefined ? ProxyIdentity.generate() : ProxyIdentity.restore(existing.value)
  if (existing === undefined) await credentials.set(credentialRef(server.identityRef), identity.exportPrivateKey())
  let authorization = `Device ${identity.endpointId}`
  if (server.mode === 'legacy') {
    const secret = await credentials.resolve(credentialRef(server.credentialRef))
    if (secret === undefined) throw new Error('DSH deployment credential is unavailable')
    authorization = `Bearer ${secret.value}`
  }
  const ca = server.caFile === undefined ? undefined : await readFile(server.caFile)
  context.signal.throwIfAborted()
  const resolved = { ...options, upgradePath: server.upgradePath === undefined ? options.upgradePath : server.upgradePath }
  if (!/^\/[A-Za-z0-9/_-]+$/.test(resolved.upgradePath)) throw new Error('Invalid DSH upgrade path')
  const connection = new DshSocketChannel(server, context, resolved, identity, authorization, ca)
  try { await connection.admit(); return connection } catch (_error) {
    await connection.close()
    throw new Error('DSH connection unavailable')
  }
}

type Catalog = Extract<ProxyFrame, { kind: 'catalog' }>
interface PendingCatalog {
  readonly done: ReturnType<typeof Promise.withResolvers<undefined>>
  readonly timer: ReturnType<typeof setTimeout>
}

class DshSocketChannel implements ManagedDshChannel {
  private readonly socket: WebSocket
  private readonly negotiated = Promise.withResolvers<undefined>()
  private readonly ended = Promise.withResolvers<undefined>()
  readonly closed: Promise<void> = this.ended.promise
  private readonly catalogs = new Map<CatalogRevision, Catalog>()
  private readonly history = new Map<CatalogRevision, string>()
  private readonly pending = new Map<CatalogRevision, PendingCatalog>()
  private acknowledged: CatalogRevision | undefined
  private channel: ProxyChannel | undefined
  private proof: Promise<AuthenticatedProxy> | undefined
  private closing: Promise<void> | undefined
  private stopped = false

  constructor(server: LocalDshSettings, private readonly context: ManagedDshContext,
    private readonly options: DshConnectionOptions, identity: ProxyIdentity, authorization: string, ca: Buffer | undefined) {
    this.socket = new WebSocket(server.origin.replace('https:', 'wss:') + options.upgradePath, {
      headers: { Authorization: authorization }, maxPayload: options.maxFrameBytes, handshakeTimeout: options.startupTimeoutMs,
      perMessageDeflate: false, ...(ca === undefined ? {} : { ca }),
    })
    this.socket.on('error', this.fail)
    this.socket.once('close', () => {
      this.stopped = true
      this.fail()
      this.ended.resolve(undefined)
    })
    context.signal.addEventListener('abort', this.fail, { once: true })
    this.socket.once('open', () => {
      this.proof = proveProxyIdentity(this.socket, identity, server.origin,
        { maxFrameBytes: options.maxFrameBytes, timeoutMs: options.startupTimeoutMs }, (peer) => {
          this.channel = attachLocalProxy(this.socket, peer, context.pool, context.catalog, options, {
            routes: context.routes, catalog: revision => this.catalogs.get(revision),
            ...(context.retired === undefined ? {} : { retired: context.retired }),
            owner: { connectionId: server.id, generation: peer.generation,
              live: () => !this.stopped && !context.signal.aborted && this.socket.readyState === WebSocket.OPEN,
              callback: (request) => {
                const channel = this.channel
                if (channel === undefined) return Promise.reject(new Error('DSH callback channel is unavailable'))
                return channel.callback(request.invocationId, request.method, request.params, options.callTimeoutMs, request.signal)
              },
            },
          })
          this.socket.on('message', (data, binary) => {
            try {
              if (binary) throw new Error('Text control frames required')
              const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
              const frame = decodeFrame(bytes.toString(), options.maxFrameBytes)
              if (frame.kind === 'catalog-accepted') {
                const pending = this.pending.get(frame.revision)
                if (pending !== undefined) { this.acknowledged = frame.revision; pending.done.resolve(undefined) }
              } else if (frame.kind === 'catalog-rejected') this.fail()
            } catch (_error) { this.fail() }
          })
        })
      void this.proof.then(() => { this.negotiated.resolve(undefined) }, this.fail)
    })
    if (context.signal.aborted) this.fail()
  }

  async admit(): Promise<void> {
    await this.negotiated.promise
    await this.publish(this.context.catalog)
  }

  async publish(catalog: Catalog): Promise<void> {
    this.assertOpen()
    const fingerprint = catalogFingerprint(catalog)
    const known = this.history.get(catalog.revision)
    if (known !== undefined && (known !== fingerprint || !this.catalogs.has(catalog.revision))) {
      throw new Error('Retired or conflicting DSH catalog revision')
    }
    if (this.acknowledged === catalog.revision) return
    const existing = this.pending.get(catalog.revision)
    if (existing !== undefined) { await existing.done.promise; return }
    if (this.pending.size >= this.options.maxPending || (known === undefined && this.history.size >= this.options.maxCatalogHistory)) {
      throw new Error('DSH catalog capacity exhausted')
    }
    if (!this.catalogs.has(catalog.revision) && this.catalogs.size >= this.options.maxCatalogRevisions) {
      const oldest = this.catalogs.keys().next().value
      if (oldest !== undefined) this.catalogs.delete(oldest)
    }
    this.catalogs.set(catalog.revision, structuredClone(catalog))
    this.history.set(catalog.revision, fingerprint)
    const done = Promise.withResolvers<undefined>()
    const timer = setTimeout(this.fail, this.options.startupTimeoutMs)
    timer.unref()
    this.pending.set(catalog.revision, { done, timer })
    try {
      await Promise.all([this.send(catalog), done.promise])
    } finally { clearTimeout(timer); this.pending.delete(catalog.revision) }
  }

  async associate(requestId: AssociationRequestId): Promise<void> {
    this.assertOpen()
    if (this.acknowledged === undefined) throw new Error('DSH catalog is not acknowledged')
    await this.send({ v: 1, kind: 'association', requestId })
  }

  close(): Promise<void> { return this.closing ??= this.shutdown() }

  private assertOpen(): void {
    this.context.signal.throwIfAborted()
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN || this.channel === undefined) throw new Error('DSH socket unavailable')
  }

  private send(frame: ProxyFrame): Promise<void> {
    this.assertOpen()
    const text = JSON.stringify(frame)
    if (Buffer.byteLength(text) > this.options.maxFrameBytes) return Promise.reject(new Error('DSH frame limit exceeded'))
    return new Promise((resolve, reject) => {
      this.socket.send(text, (error) => { if (error) reject(new Error('DSH write failed')); else resolve() })
    })
  }

  private readonly fail = (): void => {
    this.negotiated.reject(new Error('DSH admission unavailable'))
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.done.reject(new Error('DSH catalog unavailable')) }
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate()
  }

  private async shutdown(): Promise<void> {
    this.stopped = true
    this.context.signal.removeEventListener('abort', this.fail)
    this.fail()
    await this.closed
    await this.proof?.catch((_error: unknown) => { /* Handshake failure already owns its fixed admission rejection. */ })
    await this.channel?.close()
  }
}
