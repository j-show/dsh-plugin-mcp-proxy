/** Durable public device admission, separate from browser association and Session data. */
import type { EndpointId } from '@jshow/app-mcp-proxy/protocol'
import { createHash, createPublicKey } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'

const schema = z.strictObject({ version: z.literal(1), origin: z.string(), devices: z.array(z.strictObject({
  endpointId: z.string().regex(/^[a-f0-9]{64}$/), publicKey: z.string().min(1).max(4096), revoked: z.boolean(),
})) })

/** Server-owned registry location and resource budgets. */
export interface DeviceRegistryOptions {
  readonly filename: string
  readonly origin: string
  readonly maxDevices: number
  readonly maxBytes: number
  readonly lockTimeoutMs: number
}
/** Public identity authorized by an approved one-use browser ticket. */
export interface RegisteredDevice { readonly endpointId: EndpointId; readonly publicKey: string; readonly revoked: boolean }

/** Durable authority checked before every device-mode channel is admitted. */
export class DeviceRegistry {
  private devices = new Map<EndpointId, RegisteredDevice>()
  private constructor(private readonly options: DeviceRegistryOptions) {}
  /**
   * Load and validate the deployment-owned device registry.
   * @param options - deployment-owned file and limits.
   * @returns loaded durable registry.
   */
  static async open(options: DeviceRegistryOptions): Promise<DeviceRegistry> {
    const origin = new URL(options.origin)
    if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new Error('Invalid MCP registry origin')
    for (const limit of [options.maxDevices, options.maxBytes, options.lockTimeoutMs]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647) throw new Error('Invalid MCP device registry limits')
    }
    const registry = new DeviceRegistry({ ...options, filename: resolve(options.filename) })
    await mkdir(dirname(registry.options.filename), { recursive: true, mode: 0o700 })
    await withFileLock(registry.options.filename, async () => {
      try { registry.devices = await registry.read() } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
        await registry.commit([])
      }
    }, { waitMs: options.lockTimeoutMs })
    return registry
  }
  /**
   * Atomically persist a verified device while rechecking admission validity.
   * @param device - proof-verified public identity.
   * @param assertAdmission - ticket validity check under the registry lock immediately before atomic publication.
   * @returns after durable registration accepted at that commit point.
   */
  async register(device: Pick<RegisteredDevice, 'endpointId' | 'publicKey'>, assertAdmission?: () => void): Promise<void> {
    await this.change((devices) => {
      const previous = devices.get(device.endpointId)
      if (previous?.revoked) throw new Error('MCP device is revoked')
      if (previous === undefined && devices.size >= this.options.maxDevices) throw new Error('MCP device registry capacity exhausted')
      devices.set(device.endpointId, { endpointId: device.endpointId, publicKey: device.publicKey, revoked: false })
    }, assertAdmission)
  }
  /**
   * Check whether a device key is registered and not revoked.
   * @param endpointId - registered public identity.
   * @returns whether it currently has admission authority.
   */
  allows(endpointId: EndpointId): boolean { return this.devices.get(endpointId)?.revoked === false }
  /**
   * Persist revocation of the selected device.
   * @param endpointId - identity to revoke.
   * @returns after revocation is durable.
   */
  async revoke(endpointId: EndpointId): Promise<void> {
    await this.change((devices) => {
      const previous = devices.get(endpointId)
      if (previous === undefined) throw new Error('MCP device is not registered')
      devices.set(endpointId, { ...previous, revoked: true })
    })
  }

  /**
   * Reload validated device authority from durable storage.
   * @returns after reloading durable authority before a new channel upgrade.
   */
  async refresh(): Promise<void> {
    await withFileLock(this.options.filename, async () => { this.devices = await this.read() }, { waitMs: this.options.lockTimeoutMs })
  }

  private async change(operation: (devices: Map<EndpointId, RegisteredDevice>) => void, assertAdmission?: () => void): Promise<void> {
    await withFileLock(this.options.filename, async () => {
      const devices = await this.read()
      operation(devices)
      await this.commit([...devices.values()], assertAdmission)
    }, { waitMs: this.options.lockTimeoutMs })
  }

  private decode(value: unknown): Map<EndpointId, RegisteredDevice> {
    try {
      const parsed = schema.parse(value)
      if (parsed.origin !== this.options.origin) throw new Error('Device registry belongs to another DSH')
      if (parsed.devices.length > this.options.maxDevices) throw new Error('Device quota exceeded')
      const devices = new Map<EndpointId, RegisteredDevice>()
      for (const device of parsed.devices) {
        const key = createPublicKey(device.publicKey)
        const endpoint = createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex')
        if (key.asymmetricKeyType !== 'ed25519' || endpoint !== device.endpointId || devices.has(endpoint as EndpointId)) {
          throw new Error('Invalid device identity')
        }
        devices.set(endpoint as EndpointId, { ...device, endpointId: endpoint as EndpointId,
          publicKey: key.export({ format: 'pem', type: 'spki' }).toString() })
      }
      return devices
    } catch (_error) { throw new Error('Invalid MCP device registry') }
  }

  private async read(): Promise<Map<EndpointId, RegisteredDevice>> {
    const metadata = await stat(this.options.filename)
    if (!metadata.isFile() || metadata.size > this.options.maxBytes) throw new Error('Invalid MCP device registry')
    const text = await readFile(this.options.filename, 'utf8')
    if (Buffer.byteLength(text) > this.options.maxBytes) throw new Error('Invalid MCP device registry')
    let parsed: unknown
    try { parsed = JSON.parse(text) as unknown } catch (_error) { throw new Error('Invalid MCP device registry') }
    return this.decode(parsed)
  }

  private async commit(rows: readonly RegisteredDevice[], assertAdmission?: () => void): Promise<void> {
    const devices = this.decode({ version: 1, origin: this.options.origin, devices: rows })
    const text = JSON.stringify({ version: 1, origin: this.options.origin, devices: [...devices.values()] }) + '\n'
    if (Buffer.byteLength(text) > this.options.maxBytes) throw new Error('MCP device registry byte limit exceeded')
    assertAdmission?.()
    await writeFileAtomic(this.options.filename, text, { mode: 0o600, dirMode: 0o700 })
    this.devices = devices
  }
}
