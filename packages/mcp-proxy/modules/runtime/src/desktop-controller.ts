/** Allowlisted desktop management and automatic Web activation owned by the dsh profile. */
import { parseLocalManagementCommand, parseLocalManagementReply, type LocalManagementCommand,
  type LocalManagementReply, type LocalDshSettings } from '@jshow/app-mcp-proxy/local'
import { parseProxyActivation, type ProxyActivation, type DshConnectionId } from '@jshow/app-mcp-proxy/protocol'
import type { ManagedSettingsStore } from './settings-store.ts'
import type { ManagedLocalRuntime } from './managed-runtime.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Device registration provider called for a verified-format Web activation. */
export type DesktopDevicePairer = (activation: Extract<ProxyActivation, { kind:'pair' }>, signal: AbortSignal,
  caFile?: string, previous?: LocalDshSettings) => Promise<LocalDshSettings>
/** Automatic activation deduplication and connection budgets. */
export interface DesktopControllerOptions {
  readonly maxActivations: number
  readonly activationLifetimeMs: number
  readonly connectTimeoutMs: number
  readonly connectPollMs: number
}
type PairActivation = Extract<ProxyActivation, { kind:'pair' }>
interface ActivationRecord {
  readonly expiresAt: number
  readonly origin: string
  readonly stop: AbortController
  state: 'processing' | 'complete' | 'failed'
}
/** Local GUI authority; downstream execution never runs in Electron's renderer. */
export class DesktopController {
  private readonly stop = new AbortController()
  private readonly signal: AbortSignal
  private readonly activations = new Map<string, ActivationRecord>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly work = new Set<Promise<void>>()
  private readonly intents = new Map<string, number>()
  /**
   * @param store - atomic settings owner.
   * @param runtime - shared MCP/runtime owner.
   * @param pair - TLS registration provider.
   * @param options - budgets.
   * @param signal - profile lifetime.
   * @param now - local monotonic clock.
   */
  constructor(private readonly store: ManagedSettingsStore, private readonly runtime: ManagedLocalRuntime,
    private readonly pair: DesktopDevicePairer, private readonly options: DesktopControllerOptions, signal: AbortSignal,
    private readonly now: () => number = () => performance.now()) {
    this.signal = AbortSignal.any([signal, this.stop.signal])
    for (const limit of Object.values(options)) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647) throw new Error('Invalid desktop management limits')
    }
  }
  /**
   * Validate and execute an allowlisted desktop command.
   * @param input - untrusted private IPC input.
   * @returns a redacted typed result.
   */
  async handle(input: unknown): Promise<LocalManagementReply> {
    let command: LocalManagementCommand
    try { command = parseLocalManagementCommand(input) } catch (_error) { return { ok: false, code: 'invalid-request' } }
    try {
      this.signal.throwIfAborted()
      switch (command.kind) {
        case 'snapshot': break
        case 'disconnect': await this.disconnect(command.id); break
        case 'add-mcp': await this.runtime.addMcp(command.service); break
        case 'remove-mcp': await this.runtime.removeMcp(command.service); break
        case 'activate': await this.activate(parseProxyActivation(command.uri)); break
        default: assertNever(command, 'local desktop command')
      }
      return await this.snapshot()
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Local MCP credential policy changed')) return { ok: false, code: 'restart-required' }
      return { ok: false, code: command.kind === 'activate' ? 'pairing-failed' : 'operation-failed' }
    }
  }

  private async disconnect(id: DshConnectionId): Promise<void> {
    const server = (await this.store.read()).servers.find(entry => entry.id === id)
    if (server === undefined) throw new Error('DSH connection unavailable')
    this.intents.set(server.origin, (this.intents.get(server.origin) ?? 0) + 1)
    for (const record of this.activations.values()) if (record.origin === server.origin) record.stop.abort()
    await this.runtime.disconnect(id)
  }

  private async snapshot(): Promise<LocalManagementReply> {
    this.prune()
    const settings = await this.store.read()
    const state = await this.runtime.snapshot()
    return parseLocalManagementReply({ ok: true, snapshot: { ...state, version: 2, pid: process.pid,
      directory: settings.directory, settingsFile: this.store.filename,
    } })
  }

  private async activate(activation: ProxyActivation): Promise<void> {
    this.prune()
    const settings = await this.store.read()
    if (activation.kind === 'legacy') {
      const legacy = settings.servers.filter(server => server.mode === 'legacy')
      if (legacy.length !== 1) throw new Error('Legacy activation requires one preconfigured DSH')
      const server = legacy[0]
      if (server === undefined) throw new Error('Legacy DSH unavailable')
      const epoch = this.intents.get(server.origin) ?? 0
      const assert = (): void => { this.assertIntent(server.origin, epoch) }
      await this.runtime.upsertServer({ ...server, enabled: true }, assert)
      await this.waitConnected(server.id, this.signal, assert)
      assert()
      await this.runtime.associate(server.id, activation.requestId)
      return
    }
    const previous = settings.servers.find(server => server.origin === activation.origin)
    await this.connect(activation, previous?.caFile)
  }

  private async connect(activation: PairActivation, caFile?: string): Promise<void> {
    this.prune()
    const key = JSON.stringify([activation.origin, activation.requestId])
    const existing = this.activations.get(key)
    if (existing !== undefined) {
      if (existing.state === 'failed') throw new Error('A fresh browser transaction is required')
      return
    }
    if (this.activations.size >= this.options.maxActivations) throw new Error('Desktop activation capacity exhausted')
    const record: ActivationRecord = { expiresAt: this.now() + this.options.activationLifetimeMs, state: 'processing',
      origin: activation.origin, stop: new AbortController() }
    const epoch = this.intents.get(activation.origin) ?? 0
    const signal = AbortSignal.any([this.signal, record.stop.signal])
    const assert = (): void => { signal.throwIfAborted(); this.assertIntent(activation.origin, epoch) }
    this.activations.set(key, record)
    const previous = this.queues.get(activation.origin) ?? Promise.resolve()
    const operation = previous.then(async () => {
      assert()
      const settings = await this.store.read()
      const known = settings.servers.find(server => server.origin === activation.origin)
      const live = (await this.runtime.snapshot()).servers.find(server => server.id === known?.id)
      if (known?.mode === 'legacy' && live?.state === 'connected') {
        assert()
        await this.runtime.associate(known.id, activation.requestId)
      } else {
        const server = await this.pair(activation, signal, caFile, known)
        if (server.origin !== activation.origin || (known !== undefined && known.id !== server.id)) throw new Error('Paired DSH ownership mismatch')
        assert()
        await this.runtime.upsertServer(server, assert)
        await this.waitConnected(server.id, signal, assert)
        assert()
        await this.runtime.associate(server.id, activation.requestId)
      }
      record.state = 'complete'
    })
    const settled = operation.then(() => {}, () => { record.state = 'failed' })
    this.queues.set(activation.origin, settled)
    this.work.add(settled)
    void settled.then(() => {
      this.work.delete(settled)
      if (this.queues.get(activation.origin) === settled) this.queues.delete(activation.origin)
    })
    await operation
  }

  private assertIntent(origin: string, epoch: number): void {
    this.signal.throwIfAborted()
    if ((this.intents.get(origin) ?? 0) !== epoch) throw new Error('DSH connection intent was superseded')
  }

  private async waitConnected(id: DshConnectionId, signal: AbortSignal, assert: () => void): Promise<void> {
    const deadline = this.now() + this.options.connectTimeoutMs
    while (this.now() < deadline) {
      signal.throwIfAborted()
      assert()
      if ((await this.runtime.snapshot()).servers.some(server => server.id === id && server.state === 'connected')) return
      await delay(this.options.connectPollMs, undefined, { signal })
    }
    throw new Error('DSH connection deadline exceeded')
  }

  private prune(): void {
    for (const [key, record] of this.activations) {
      if (record.state !== 'processing' && this.now() >= record.expiresAt) this.activations.delete(key)
    }
  }
  /**
   * Cancel pending activations and wait for their work to settle.
   * @returns after pending registration operations have drained.
   */
  async close(): Promise<void> {
    this.stop.abort()
    await Promise.all(this.work)
    this.activations.clear()
  }
}
