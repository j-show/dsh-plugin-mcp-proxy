/** Application-owned deployment connection initialization. */
import type { ManagedSettingsStore } from '@jshow/app-mcp-proxy/runtime/desktop'
import type { LocalDshSettings } from '@jshow/app-mcp-proxy/local'
import { createHash, X509Certificate } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const schema = z.array(z.strictObject({
  origin: z.url().refine(value => new URL(value).protocol === 'https:' && new URL(value).origin === value),
  certificate: z.string().min(1).max(65536),
})).max(32)

/**
 * Validate deployment metadata and retain only normalized public certificates.
 * @param input - parsed deployment JSON, never an activation URI.
 * @returns canonical origins with their public PEM certificates.
 */
export function parseBundledConnections(input: unknown): ReadonlyArray<{ origin: string; certificate: string }> {
  try {
    const entries = schema.parse(input), origins = new Set<string>()
    return entries.map((entry) => {
      const publicPem = /^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/
      if (origins.has(entry.origin) || !publicPem.test(entry.certificate)) {
        throw new Error('Invalid certificate or duplicate origin')
      }
      origins.add(entry.origin)
      return { origin: entry.origin, certificate: new X509Certificate(entry.certificate).toString().trim() + '\n' }
    })
  } catch (_error) { throw new Error('Invalid bundled connection metadata') }
}

/**
 * Apply deployment-provided trust without starting a DSH connection.
 * @param filename - optional bundled public connection metadata.
 * @param certificates - application-owned public certificate directory.
 * @param store - validated atomic settings owner.
 * @returns after settings initialization completes.
 */
export async function applyBundledConnections(filename: string, certificates: string,
  store: ManagedSettingsStore): Promise<void> {
  let input: unknown
  try {
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152) throw new Error('Invalid bundled connection file')
    input = JSON.parse(await readFile(filename, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw new Error('Unreadable bundled connection metadata')
  }
  const entries = parseBundledConnections(input)
  if (entries.length === 0) return
  await mkdir(certificates, { recursive: true, mode: 0o700 })
  const directory = await lstat(certificates)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid bundled connection certificate directory')
  const servers: LocalDshSettings[] = []
  for (const entry of entries) {
    const digest = createHash('sha256').update(entry.certificate).digest('hex')
    const caFile = join(certificates, digest + '.pem')
    try { await writeFile(caFile, entry.certificate, { flag: 'wx', mode: 0o600 }) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const previous = await lstat(caFile)
      if (!previous.isFile() || previous.isSymbolicLink() || await readFile(caFile, 'utf8') !== entry.certificate) {
        throw new Error('Existing bundled connection certificate differs')
      }
    }
    const originHash = createHash('sha256').update(entry.origin).digest('hex')
    servers.push({ id: ('deployment-' + originHash.slice(0, 32)) as LocalDshSettings['id'], origin: entry.origin,
      enabled: false, mode: 'device', identityRef: 'MCP_PROXY_DEVICE_' + originHash.toUpperCase(), caFile })
  }
  await store.update((state) => {
    const merged = [...state.servers]
    for (const server of servers) {
      const previous = merged.find(existing => existing.origin === server.origin)
      if (previous === undefined) merged.push(server)
      else if (previous.caFile === undefined) merged[merged.indexOf(previous)] = { ...previous, caFile: server.caFile }
    }
    return { ...state, servers: merged }
  })
}
