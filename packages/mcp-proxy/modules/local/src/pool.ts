/** Owned downstream clients, immutable catalog publication and serialized service execution. */
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { decodeFrame, ProxyToolSchema, type ProxyFrame, type ProxyTool, type InvocationId, type ServiceIncarnationId } from '@jshow/app-mcp-proxy/protocol'
import type { LocalServiceConfig } from './config.ts'
import { openDriver, type LocalDriver, type LocalOptions } from './drivers.ts'
import type { LocalClientRequestHandler } from './callbacks.ts'
import { localProcessEnvironment } from './environment.ts'

/** Caller-owned startup cancellation and credential references excluded from implicit child inheritance. */
export interface LocalStartupPolicy { readonly signal?: AbortSignal; readonly excludeEnvironment?: readonly string[] }

type Catalog = Extract<ProxyFrame, { kind: 'catalog' }>
type Result = Extract<ProxyFrame, { kind: 'result' }>['result']

function invocationAbort(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('Local MCP invocation cancelled', 'AbortError')
}

interface Slot {
  paused: boolean
  descriptor?: Catalog['services'][number]
  incarnation: ServiceIncarnationId
  readonly stop: AbortController
  driver: LocalDriver
  readonly config: LocalServiceConfig
  readonly tools: Map<string, unknown>
  readonly directory: string
  readonly roots: readonly string[]
  tail: Promise<void>
}

/** A single runtime's configured MCP clients; close cancels work and awaits SDK teardown. */
export class LocalMcpPool {
  private readonly slots = new Map<string, Slot>()
  private readonly stop = new AbortController()
  private snapshot: Catalog | undefined
  private closing: Promise<void> | undefined
  private mutation: Promise<void> = Promise.resolve()
  private readonly retiring = new Set<Slot>()

  private constructor(
    private readonly options: LocalOptions, private readonly requests: LocalClientRequestHandler | undefined,
    private environment: Record<string, string>,
  ) {}

  /**
   * Connect every configured service and validate a complete catalog before returning.
   * @param services - resolved local service entries.
   * @param options - explicit discovery, size and operation limits.
   * @param requests - optional model/human request owner; unsupported callbacks are not advertised.
   * @param startup - caller-owned startup cancellation and implicit environment exclusions.
   * @returns an owned ready pool; startup failure closes all clients already connected.
   */
  static async open(
    services: readonly LocalServiceConfig[], options: LocalOptions, requests?: LocalClientRequestHandler, startup: LocalStartupPolicy = {},
  ): Promise<LocalMcpPool> {
    for (const [name, value] of Object.entries(options)) {
      if (!Number.isSafeInteger(value) || value < 1 || (name.endsWith('TimeoutMs') && value > 2_147_483_647)) {
        throw new RangeError(`Invalid local MCP limit: ${name}`)
      }
    }
    if (services.length > options.maxServices) throw new Error('Local MCP service limit exceeded')
    const deadline = new AbortController()
    const signal = startup.signal === undefined ? deadline.signal : AbortSignal.any([startup.signal, deadline.signal])
    signal.throwIfAborted()
    const environment = localProcessEnvironment(startup.excludeEnvironment ?? [])
    const pool = new LocalMcpPool({ ...options }, requests, environment)
    const timer = setTimeout(() => { deadline.abort() }, options.startupTimeoutMs)
    timer.unref()
    try {
      for (const config of structuredClone(services)) {
        signal.throwIfAborted()
        if (pool.slots.has(config.service)) throw new Error('Duplicate local MCP service alias')
        const driver = await openDriver(structuredClone(config), pool.options, requests, environment, signal)
        pool.slots.set(config.service, { driver, config, tools: new Map(), tail: Promise.resolve(),
          incarnation: randomUUID() as ServiceIncarnationId, stop: new AbortController(), paused: false,
          directory: config.cwd, roots: config.roots.map(root => pathToFileURL(root).href),
        })
        signal.throwIfAborted()
      }
      await pool.discover(signal)
      return pool
    } catch (_error) {
      try {
        await pool.close()
      } catch (_cleanupError) {
        throw new AggregateError([new Error('Local MCP startup failed'), new Error('Local MCP cleanup failed')], 'Local MCP startup and cleanup failed')
      }
      throw new Error('Local MCP startup failed')
    } finally { clearTimeout(timer) }
  }

  /**
   * Read the negotiated catalog for live MCP clients.
   * @returns a detached complete catalog; rejects after close.
   */
  catalog(): Promise<Catalog> {
    if (this.stop.signal.aborted || this.snapshot === undefined) return Promise.reject(new Error('Local MCP pool is not ready'))
    return Promise.resolve(structuredClone(this.snapshot))
  }

  /** Whether every client in the published catalog still admits operations. */
  get available(): boolean {
    return !this.stop.signal.aborted && this.snapshot !== undefined && [...this.slots.values()].every(slot => slot.driver.connected)
  }

  /**
   * Protect deployment credential variables from downstream child environments.
   * @param references - all currently configured DSH credential references.
   * @returns after excluding newly declared names from future child environments.
   * @throws when a running child may already have inherited a newly protected name, requiring profile restart.
   */
  excludeCredentialReferences(references: readonly string[]): void {
    localProcessEnvironment(references)
    const blocked = new Set(references.map(reference => reference.toUpperCase()))
    const next = Object.fromEntries(Object.entries(this.environment).filter(([name]) => !blocked.has(name.toUpperCase())))
    if (this.slots.size > 0 && Object.keys(next).length !== Object.keys(this.environment).length) {
      throw new Error('Local MCP credential policy changed; restart the local profile before admission')
    }
    this.environment = next
  }

  /**
   * Refresh the catalog and replace retired clients after the old proxy channel has drained.
   * The caller must keep this pool detached from invocation channels until recovery settles.
   * @param signal - runtime lifetime cancelling replacement startup and discovery.
   * @returns the complete refreshed catalog; failure leaves the pool unavailable for attachment.
   */
  async recover(signal: AbortSignal): Promise<Catalog> {
    const combined = AbortSignal.any([signal, this.stop.signal])
    combined.throwIfAborted()
    await Promise.all([...this.slots.values()].map(slot => slot.tail))
    this.snapshot = undefined
    for (const slot of this.slots.values()) {
      combined.throwIfAborted()
      if (!slot.driver.connected) {
        await slot.driver.close()
        slot.driver = await openDriver(structuredClone(slot.config), this.options, this.requests, this.environment, combined)
        slot.incarnation = randomUUID() as ServiceIncarnationId
      }
    }
    await this.discover(combined)
    return this.catalog()
  }

  /**
   * Replace one retired MCP client without replaying calls.
   * @param service - retired alias.
   * @param signal - runtime lifetime.
   * @returns after replacing only that client and publishing discovery.
   */
  recoverService(service: string, signal: AbortSignal): Promise<void> {
    return this.change(async () => {
      const combined = AbortSignal.any([signal, this.stop.signal, AbortSignal.timeout(this.options.startupTimeoutMs)])
      combined.throwIfAborted()
      const slot = this.slots.get(service)
      if (slot === undefined || slot.paused) throw new Error('Local MCP service is unavailable')
      await slot.tail
      combined.throwIfAborted()
      if (slot.driver.connected) return
      await slot.driver.close()
      slot.driver = await openDriver(structuredClone(slot.config), this.options, this.requests, this.environment, combined)
      slot.incarnation = randomUUID() as ServiceIncarnationId
      try { await this.discoverSlot(service, slot, combined); this.publish() } catch (error) {
        await slot.driver.close()
        throw error
      }
    })
  }

  /**
   * Invoke a discovered tool with local service identity preserved.
   * @param service - configured stable alias.
   * @param name - raw downstream tool name.
   * @param args - model/tool JSON arguments.
   * @param signal - parent invocation cancellation.
   * @param invocationId - exact proxy parent identity for model/human callbacks.
   * @param assertOwner - optional caller ownership check repeated after queueing.
   * @returns protocol-complete result; MCP isError remains an error-marked result.
   */
  call(service: string, name: string, args: Record<string, unknown>, signal: AbortSignal,
    invocationId?: InvocationId, assertOwner?: () => void): Promise<Result> {
    const slot = this.slots.get(service)
    if (slot === undefined || slot.paused || !slot.tools.has(name)) return Promise.reject(new Error('Local MCP tool is not discovered'))
    const incarnation = slot.incarnation
    const combined = AbortSignal.any([signal, this.stop.signal, slot.stop.signal])
    if (combined.aborted) return Promise.reject(invocationAbort(combined))
    const admittedArgs = structuredClone(args)
    const result = slot.tail.then(async () => {
      combined.throwIfAborted()
      assertOwner?.()
      if (!slot.driver.connected || slot.paused || this.slots.get(service) !== slot || slot.incarnation !== incarnation) {
        throw new Error('Local MCP service or catalog is unavailable')
      }
      const raw = await slot.driver.call(name, admittedArgs, combined, slot.tools.get(name), invocationId)
      const frame = decodeFrame(JSON.stringify({ v: 1, kind: 'result', id: 'local', generation: 'local', result: raw }), this.options.maxFrameBytes)
      if (frame.kind !== 'result') throw new Error('Invalid local MCP result')
      return frame.result
    })
    // A failed operation must not poison the queue; the caller still receives the original rejection.
    slot.tail = result.then(() => {}, () => {})
    return this.observe(result, combined)
  }

  /** Close owned clients and wait for admitted work; never stop externally hosted MCP servers. */
  close(): Promise<void> {
    return this.closing ??= this.shutdown()
  }

  /**
   * Check whether the pinned MCP client incarnation remains live.
   * @param service - stable alias.
   * @param incarnation - pinned client identity.
   * @returns whether that exact client remains available.
   */
  hasIncarnation(service: string, incarnation: ServiceIncarnationId | undefined): boolean {
    const slot = this.slots.get(service)
    return !this.stop.signal.aborted && slot !== undefined && !slot.paused && slot.incarnation === incarnation && slot.driver.connected
  }

  /**
   * Check both client incarnation and pinned tool definition.
   * @param tool - pinned model-visible definition.
   * @param incarnation - original client.
   * @returns whether both still match discovery.
   */
  matchesTool(tool: ProxyTool, incarnation: ServiceIncarnationId | undefined): boolean {
    if (!this.hasIncarnation(tool.service, incarnation)) return false
    const raw = this.slots.get(tool.service)?.tools.get(tool.name)
    return raw !== undefined && isDeepStrictEqual(tool, ProxyToolSchema.parse({ ...(raw as object), service: tool.service }))
  }

  /**
   * Stop new calls to one MCP until removal commits or admission resumes.
   * @param service - alias whose new calls must stop.
   * @returns rollback of admission blocking if the same client still exists.
   */
  pause(service: string): () => void {
    this.stop.signal.throwIfAborted()
    const slot = this.slots.get(service)
    if (slot === undefined || slot.paused) throw new Error('Local MCP service is unavailable')
    slot.paused = true
    return () => { if (this.slots.get(service) === slot) slot.paused = false }
  }

  /**
   * Negotiate a new MCP before adding it to the shared catalog.
   * @param config - validated local entry.
   * @param signal - management lifetime.
   * @returns after discovery and atomic catalog publication.
   */
  add(config: LocalServiceConfig, signal: AbortSignal): Promise<void> {
    return this.change(async () => {
      const combined = AbortSignal.any([signal, this.stop.signal, AbortSignal.timeout(this.options.startupTimeoutMs)])
      combined.throwIfAborted()
      if (this.slots.has(config.service) || this.slots.size >= this.options.maxServices) throw new Error('Local MCP service conflicts or capacity exhausted')
      const frozen = structuredClone(config)
      const driver = await openDriver(frozen, this.options, this.requests, this.environment, combined)
      const slot: Slot = { driver, config: frozen, tools: new Map(), tail: Promise.resolve(),
        stop: new AbortController(), paused: false,
        incarnation: randomUUID() as ServiceIncarnationId, directory: frozen.cwd,
        roots: frozen.roots.map(root => pathToFileURL(root).href) }
      try {
        await this.discoverSlot(config.service, slot, combined)
        combined.throwIfAborted()
        this.slots.set(config.service, slot)
        this.publish()
      } catch (error) {
        this.slots.delete(config.service)
        this.retiring.add(slot)
        await driver.close()
        this.retiring.delete(slot)
        throw error
      }
    })
  }

  /**
   * Cancel and drain one MCP while preserving unrelated clients.
   * @param service - alias to retire.
   * @returns after affected calls and the owned client have drained.
   */
  remove(service: string): Promise<void> {
    return this.change(async () => {
      this.stop.signal.throwIfAborted()
      const slot = this.slots.get(service)
      if (slot === undefined) throw new Error('Local MCP service is not configured')
      this.slots.delete(service)
      this.retiring.add(slot)
      slot.stop.abort()
      try { this.publish() } finally {
        await slot.driver.close()
        await slot.tail
        this.retiring.delete(slot)
      }
    })
  }

  private change(operation: () => Promise<void>): Promise<void> {
    const result = this.mutation.then(operation)
    this.mutation = result.then(() => {}, () => {})
    return result
  }

  private async discover(signal?: AbortSignal): Promise<void> {
    for (const [service, slot] of this.slots) await this.discoverSlot(service, slot, signal)
    signal?.throwIfAborted()
    this.publish()
  }

  private async discoverSlot(service: string, slot: Slot, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const connected = (): boolean => slot.driver.connected
    if (!connected()) throw new Error('Local MCP service is disconnected')
    slot.tools.clear()
    for (const raw of await slot.driver.tools(signal)) {
      signal?.throwIfAborted()
      const tool = ProxyToolSchema.parse({ ...(raw as object), service })
      if (slot.tools.has(tool.name)) throw new Error('Duplicate local MCP tool identity')
      slot.tools.set(tool.name, raw)
    }
    if (!connected()) throw new Error('Local MCP service disconnected during discovery')
    const instructions = slot.driver.instructions()
    const serverInfo = slot.driver.info()
    slot.descriptor = { service, incarnation: slot.incarnation, directory: slot.directory, roots: [...slot.roots],
      ...(instructions === undefined ? {} : { instructions }),
      ...(serverInfo === undefined ? {} : { serverInfo: z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(serverInfo))) }),
    }
  }

  private publish(): void {
    const services: Catalog['services'] = []
    const tools: Catalog['tools'] = []
    for (const [service, slot] of this.slots) {
      if (slot.descriptor === undefined) throw new Error('Local MCP service has no discovered metadata')
      services.push(structuredClone(slot.descriptor))
      for (const raw of slot.tools.values()) {
        const tool = ProxyToolSchema.parse({ ...(raw as object), service })
        tools.push(tool)
      }
    }
    const revision = createHash('sha256').update(JSON.stringify({ services, tools })).digest('hex')
    const parsed = decodeFrame(JSON.stringify({ v: 1, kind: 'catalog', revision, services, tools }), this.options.maxFrameBytes)
    if (parsed.kind !== 'catalog') throw new Error('Invalid local MCP catalog')
    this.snapshot = parsed
  }

  private async shutdown(): Promise<void> {
    this.stop.abort()
    await this.mutation
    const owned = new Set([...this.slots.values(), ...this.retiring])
    const closed = await Promise.allSettled([...owned].map(slot => slot.driver.close()))
    await Promise.all([...owned].map(slot => slot.tail))
    const failures = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new Error('Local MCP cleanup failed')
  }

  private observe<ResultValue>(operation: Promise<ResultValue>, signal: AbortSignal): Promise<ResultValue> {
    return new Promise((resolve, reject) => {
      const abort = (): void => { signal.removeEventListener('abort', abort); reject(invocationAbort(signal)) }
      signal.addEventListener('abort', abort, { once: true })
      operation.then((value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      }, (_error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(signal.aborted ? invocationAbort(signal) : new Error('Local MCP invocation failed'))
      })
      if (signal.aborted) abort()
    })
  }
}
