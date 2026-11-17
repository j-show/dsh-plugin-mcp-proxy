/** Shared local MCP ownership and independently reconnecting DSH channels. */
import { LocalInvocationRoutes, LocalMcpPool, resolveLocalServices, type LocalOptions, type LocalDshSettings,
  type LocalDesktopSnapshot } from '@jshow/app-mcp-proxy/local'
import type { AssociationRequestId, DshConnectionId, ProxyFrame } from '@jshow/app-mcp-proxy/protocol'
import type { ManagedSettingsStore } from './settings-store.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

type Catalog = Extract<ProxyFrame, { kind:'catalog' }>
/** One independently admitted DSH channel. */
export interface ManagedDshChannel {
  readonly closed: Promise<void>
  publish(catalog: Catalog): Promise<void>
  associate(id: AssociationRequestId): Promise<void>
  close(): Promise<void>
}
/** Dependencies transferred to a DSH channel without transferring pool ownership. */
export interface ManagedDshContext {
  readonly pool: LocalMcpPool
  readonly routes: LocalInvocationRoutes
  readonly catalog: Catalog
  readonly signal: AbortSignal
  readonly retired?: (service: string) => void
}
/** Admission provider; resolves only after authenticated catalog acknowledgement. */
export type ManagedDshConnector = (server: LocalDshSettings, context: ManagedDshContext) => Promise<ManagedDshChannel>
/** Explicit shared-runtime capacities and client limits. */
export interface ManagedRuntimeOptions {
  readonly pool: LocalOptions
  readonly maxServers: number
  readonly maxInvocations: number
  readonly reconnectDelayMs: number
}
/** Redacted state shared by the GUI and tray. */
export type ManagedRuntimeSnapshot = Pick<LocalDesktopSnapshot, 'servers' | 'services'>
interface ConnectionRecord {
  readonly spec: LocalDshSettings
  readonly stop: AbortController
  state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
  channel: ManagedDshChannel | undefined
  work?: Promise<void>
}
/** Manage channels around one shared pool; no current-server selection participates in routing. */
export class ManagedLocalRuntime {
  /** Whether at least one DSH has acknowledged its current catalog. */
  get connected(): boolean { return !this.lifetime.aborted && [...this.records.values()].some(record => record.state === 'connected') }
  private readonly records = new Map<DshConnectionId, ConnectionRecord>()
  private closing: Promise<void> | undefined
  private management: Promise<void> = Promise.resolve()
  private readonly recovering = new Set<string>()
  private readonly registryWork = new Map<DshConnectionId, Promise<void>>()
  private constructor(private readonly store: ManagedSettingsStore, private readonly options: ManagedRuntimeOptions,
    private readonly connector: ManagedDshConnector, private readonly pool: LocalMcpPool,
    private readonly routes: LocalInvocationRoutes, private readonly stop: AbortController, private readonly lifetime: AbortSignal,
    private catalog: Catalog) {}
  /**
   * Open the shared MCP pool and reconcile enabled DSH connections.
   * @param store - persistent configuration owner.
   * @param options - validated limits.
   * @param connector - channel admission provider.
   * @param signal - profile lifetime.
   * @returns live shared runtime, including empty configuration.
   */
  static async open(store: ManagedSettingsStore, options: ManagedRuntimeOptions, connector: ManagedDshConnector,
    signal: AbortSignal): Promise<ManagedLocalRuntime> {
    for (const limit of [options.maxServers, options.maxInvocations, options.reconnectDelayMs]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647) throw new Error('Invalid managed runtime limits')
    }
    const settings = await store.read()
    if (settings.servers.length > options.maxServers) throw new Error('Local DSH connection limit exceeded')
    const stop = new AbortController()
    const lifetime = AbortSignal.any([signal, stop.signal])
    const routes = new LocalInvocationRoutes(options.maxInvocations)
    const excludeEnvironment = settings.servers.flatMap(server => server.mode === 'legacy'
      ? [server.credentialRef, server.identityRef] : [server.identityRef])
    const pool = await LocalMcpPool.open(settings.services, options.pool, request => routes.request(request),
      { signal: lifetime, excludeEnvironment })
    const runtime = new ManagedLocalRuntime(store, options, connector, pool, routes, stop, lifetime, await pool.catalog())
    try { await runtime.reloadServers(); return runtime } catch (error) { await runtime.close(); throw error }
  }
  /**
   * Read redacted connection and MCP readiness state.
   * @returns a redacted snapshot.
   */
  async snapshot(): Promise<ManagedRuntimeSnapshot> {
    const settings = await this.store.read()
    const catalog = await this.pool.catalog()
    return { servers: [...this.records.values()].map(record => ({ id:record.spec.id,origin:record.spec.origin,state:record.state })),
      services: settings.services.map(service => ({ service: service.service, transport: service.transport,
        ready: this.pool.hasIncarnation(service.service, catalog.services.find(entry => entry.service === service.service)?.incarnation),
      })) }
  }
  /**
   * Persist disabled intent and cancel work owned by this DSH connection.
   * @param id - exact DSH to disable.
   * @returns after its channel has drained.
   */
  async disconnect(id: DshConnectionId): Promise<void> {
    this.lifetime.throwIfAborted()
    const record = this.records.get(id)
    if (record === undefined) throw new Error('DSH connection is not configured')
    await this.store.update(state => ({ ...state, servers: state.servers.map(server => server.id === id
      ? { ...server, enabled: false } : server) }))
    await this.reconcile(id)
  }

  /**
   * Negotiate and persist a new MCP before publishing its catalog.
   * @param input - local form fields.
   * @returns after validated persistence and catalog publication.
   */
  addMcp(input: unknown): Promise<void> {
    return this.change(async () => {
      let added: string | undefined
      try {
        await this.store.update(async (state) => {
          this.excludeCredentials(state.servers)
          const [service] = resolveLocalServices([input], state.directory)
          if (service === undefined) throw new Error('Invalid local MCP entry')
          await this.pool.add(service, this.lifetime)
          added = service.service
          return { ...state, services: [...state.services, service] }
        })
      } catch (error) {
        if (added !== undefined) await this.pool.remove(added)
        throw error
      }
      this.catalog = await this.pool.catalog()
      await this.publish()
    })
  }

  /**
   * Remove a shared MCP and cancel its calls across DSH connections.
   * @param service - configured local alias.
   * @returns after removal and affected-call cleanup.
   */
  removeMcp(service: string): Promise<void> {
    return this.change(async () => {
      let resume: (() => void) | undefined
      try {
        await this.store.update((state) => {
          if (!state.services.some(entry => entry.service === service)) throw new Error('Local MCP is not configured')
          resume = this.pool.pause(service)
          return { ...state, services: state.services.filter(entry => entry.service !== service) }
        })
      } catch (error) { resume?.(); throw error }
      try { await this.pool.remove(service) } finally {
        this.catalog = await this.pool.catalog()
        await this.publish()
      }
    })
  }

  /**
   * Send a browser transaction through its selected DSH connection.
   * @param id - exact configured DSH.
   * @param ticket - that DSH's browser transaction.
   * @returns socket-write acknowledgement.
   */
  async associate(id: DshConnectionId, ticket: AssociationRequestId): Promise<void> {
    const record = this.records.get(id)
    if (record?.state !== 'connected' || record.stop.signal.aborted || record.channel === undefined) {
      throw new Error('Selected DSH connection unavailable')
    }
    await record.channel.associate(ticket)
  }

  /**
   * Persist one DSH entry and reconcile only that connection.
   * @param server - registered entry, preserving an existing origin's local ID.
   * @param assertIntent - optional guard repeated inside the configuration lock.
   * @returns after persisting enabled intent and scheduling admission.
   */
  async upsertServer(server: LocalDshSettings, assertIntent?: () => void): Promise<void> {
    this.lifetime.throwIfAborted()
    await this.store.update((state) => {
      this.lifetime.throwIfAborted()
      assertIntent?.()
      const previous = state.servers.find(entry => entry.origin === server.origin)
      if (previous !== undefined && previous.id !== server.id) throw new Error('DSH origin identity cannot change implicitly')
      const others = state.servers.filter(entry => entry.origin !== server.origin)
      if (others.length >= this.options.maxServers) throw new Error('Local DSH connection limit exceeded')
      return { ...state, servers: [...others, server] }
    })
    await this.reconcile(server.id)
  }

  private change(operation: () => Promise<void>): Promise<void> {
    const result = this.management.then(async () => { this.lifetime.throwIfAborted(); await operation() })
    this.management = result.then(() => {}, () => {})
    return result
  }

  private async publish(): Promise<void> {
    await Promise.all([...this.records.values()].map(async (record) => {
      const channel = record.channel
      if (channel === undefined) return
      try { await channel.publish(structuredClone(this.catalog)) } catch (_error) {
        // The admission loop reconnects only the channel whose publication failed.
        record.state = 'reconnecting'
        await channel.close()
      }
    }))
  }

  /**
   * Reconcile each connection against the latest committed settings.
   * @returns after configured server intents have been applied; connection establishment remains independent.
   */
  async reloadServers(): Promise<void> {
    this.lifetime.throwIfAborted()
    const settings = await this.store.read()
    if (settings.servers.length > this.options.maxServers) throw new Error('Local DSH connection limit exceeded')
    this.excludeCredentials(settings.servers)
    const ids = new Set([...this.records.keys(), ...settings.servers.map(server => server.id)])
    await Promise.all([...ids].map(id => this.reconcile(id)))
  }

  private reconcile(id: DshConnectionId): Promise<void> {
    const previousWork = this.registryWork.get(id) ?? Promise.resolve()
    const operation = previousWork.then(async () => {
      this.lifetime.throwIfAborted()
      const settings = await this.store.read()
      this.excludeCredentials(settings.servers)
      const server = settings.servers.find(entry => entry.id === id)
      const previous = this.records.get(id)
      if (server !== undefined && previous !== undefined && !previous.stop.signal.aborted
        && server.enabled && isDeepStrictEqual(previous.spec, server)) return
      if (previous !== undefined) {
        previous.stop.abort()
        await previous.channel?.close()
        await previous.work
      }
      this.lifetime.throwIfAborted()
      if (server === undefined) { this.records.delete(id); return }
      const record: ConnectionRecord = { spec: structuredClone(server), stop: new AbortController(), channel: undefined,
        state: server.enabled ? 'connecting' : 'disconnected' }
      this.records.set(id, record)
      if (server.enabled) {
        record.work = this.connect(record)
        void record.work.catch((_error: unknown) => { record.state = 'error' })
      }
    })
    const settled = operation.then(() => {}, () => {})
    this.registryWork.set(id, settled)
    void settled.then(() => { if (this.registryWork.get(id) === settled) this.registryWork.delete(id) })
    return operation
  }

  private async connect(record: ConnectionRecord): Promise<void> {
    const signal = AbortSignal.any([record.stop.signal, this.lifetime])
    const stopped = (): boolean => signal.aborted
    while (!stopped()) {
      let channel: ManagedDshChannel | undefined
      try {
        channel = await this.connector(record.spec, { pool: this.pool, routes: this.routes,
          catalog: structuredClone(this.catalog), signal, retired: (service) => { this.recover(service) } })
        signal.throwIfAborted()
        record.channel = channel
        await channel.publish(structuredClone(this.catalog))
        signal.throwIfAborted()
        record.state = 'connected'
        await channel.closed
      } catch (_error) {
        // TLS, credential and provider details stay inside their owning admission layer.
        record.state = stopped() ? 'disconnected' : 'reconnecting'
      } finally {
        record.channel = undefined
        await channel?.close()
      }
      if (stopped()) break
      record.state = 'reconnecting'
      try { await delay(this.options.reconnectDelayMs, undefined, { signal }) } catch (error) {
        if (!stopped()) throw error
      }
    }
    record.state = 'disconnected'
  }
  private excludeCredentials(servers: readonly LocalDshSettings[]): void {
    this.pool.excludeCredentialReferences(servers.flatMap(server => server.mode === 'legacy'
      ? [server.credentialRef, server.identityRef] : [server.identityRef]))
  }

  private recover(service: string): void {
    if (this.recovering.has(service) || this.lifetime.aborted) return
    this.recovering.add(service)
    const operation = this.change(async () => {
      const descriptor = this.catalog.services.find(entry => entry.service === service)
      if (descriptor === undefined || this.pool.hasIncarnation(service, descriptor.incarnation)) return
      this.excludeCredentials((await this.store.read()).servers)
      await this.pool.recoverService(service, this.lifetime)
      this.catalog = await this.pool.catalog()
      await this.publish()
    })
    void operation.then(() => { this.recovering.delete(service) }, () => {
      // The unavailable service stays visible and no accepted invocation is replayed.
      this.recovering.delete(service)
    })
  }

  /**
   * Drain connections and calls before closing the shared MCP pool.
   * @returns after channels and local MCP children have drained.
   */
  close(): Promise<void> { return this.closing ??= this.shutdown() }

  private async shutdown(): Promise<void> {
    this.stop.abort()
    await this.management
    await Promise.all(this.registryWork.values())
    for (const record of this.records.values()) record.stop.abort()
    const channels = await Promise.allSettled([...this.records.values()].map(async (record) => { await record.channel?.close() }))
    const loops = await Promise.allSettled([...this.records.values()].map(async (record) => { await record.work }))
    await this.pool.close()
    if ([...channels, ...loops].some(result => result.status === 'rejected')) throw new Error('DSH channel cleanup failed')
  }
}
