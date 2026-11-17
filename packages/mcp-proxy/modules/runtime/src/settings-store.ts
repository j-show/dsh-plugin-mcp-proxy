/** Atomic local GUI configuration and explicit legacy migration. */
import { parseManagedMcpSettings, readMcpProxySettings, type ManagedMcpSettings } from '@jshow/app-mcp-proxy/local'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch (_error) { throw new Error('Invalid managed MCP configuration') }
}

/** Explicit bootstrap locations and file-lock budget. */
export interface ManagedSettingsOptions {
  readonly filename: string
  readonly directory: string
  readonly identityFile: string
  readonly legacyIdentityRef: string
  readonly waitMs: number
}

/** Serialized settings owner; readers receive detached validated snapshots. */
export class ManagedSettingsStore {
  private constructor(private readonly options: ManagedSettingsOptions) {}
  /** Absolute configuration filename shown in the desktop diagnostics. */
  get filename(): string { return this.options.filename }
  /**
   * Load or initialize managed settings while preserving invalid files and legacy backups.
   * @param options - bootstrap defaults.
   * @returns initialized or migrated settings owner.
   */
  static async open(options: ManagedSettingsOptions): Promise<ManagedSettingsStore> {
    const filename = resolve(options.filename)
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    const store = new ManagedSettingsStore({ ...options, filename })
    await withFileLock(filename, async () => {
      let original: string
      try { original = await readFile(filename, 'utf8') } catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error
        const initial = parseManagedMcpSettings({ version: 2, directory: options.directory, identityFile: options.identityFile,
          services: [], servers: [] }, dirname(filename))
        await mkdir(initial.directory, { recursive: true, mode: 0o700 })
        await store.commit(initial)
        return
      }
      const value = parseJson(original)
      if (typeof value === 'object' && value !== null && 'version' in value && value.version === 2) {
        parseManagedMcpSettings(value, dirname(filename))
        return
      }
      const legacy = await readMcpProxySettings(filename)
      const id = 'legacy-' + createHash('sha256').update(legacy.server.origin).digest('hex')
      const migrated = parseManagedMcpSettings({ version: 2, directory: legacy.directory, identityFile: legacy.identityFile,
        services: legacy.services, servers: [{ id, ...legacy.server, enabled: true, mode: 'legacy', identityRef: options.legacyIdentityRef }],
      }, dirname(filename))
      try { await writeFile(filename + '.v1.bak', original, { flag: 'wx', mode: 0o600 }) } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
        if (await readFile(filename + '.v1.bak', 'utf8') !== original) throw new Error('MCP settings migration backup conflicts')
      }
      await store.commit(migrated)
    }, { waitMs: options.waitMs })
    return store
  }
  /**
   * Read and validate the current committed settings.
   * @returns current validated settings without exposing parser input in diagnostics.
   */
  async read(): Promise<ManagedMcpSettings> {
    return parseManagedMcpSettings(parseJson(await readFile(this.options.filename, 'utf8')), dirname(this.options.filename))
  }
  /**
   * Serialize a validated settings update under the publication lock.
   * @param mutate - update based on the latest committed state.
   * @returns the committed validated snapshot.
   */
  async update(mutate: (current: ManagedMcpSettings) => unknown): Promise<ManagedMcpSettings> {
    return withFileLock(this.options.filename, async () => {
      const next = parseManagedMcpSettings(await mutate(await this.read()), dirname(this.options.filename))
      await this.commit(next)
      return next
    }, { waitMs: this.options.waitMs })
  }

  private async commit(settings: ManagedMcpSettings): Promise<void> {
    await writeFileAtomic(this.options.filename, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
  }
}
