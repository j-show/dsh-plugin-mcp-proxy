/** Versioned shared local services and independent DSH deployment configuration. */
import { resolve } from 'node:path'
import { z } from 'zod'
import type { DshConnectionId } from '@j-show/mcp-proxy-protocol'
import { resolveLocalServices, type LocalServiceConfig } from './config.ts'

const ref = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const common = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).transform(value => value as DshConnectionId),
  origin: z.url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value }),
  enabled: z.boolean(), identityRef: ref, caFile: z.string().min(1).optional(),
  upgradePath: z.string().regex(/^\/[A-Za-z0-9/_-]+$/).optional(),
}
const server = z.discriminatedUnion('mode', [
  z.strictObject({ ...common, mode: z.literal('device') }),
  z.strictObject({ ...common, mode: z.literal('legacy'), credentialRef: ref }),
])
const schema = z.strictObject({ version: z.literal(2), directory: z.string().min(1), identityFile: z.string().min(1),
  services: z.array(z.unknown()), servers: z.array(server) })

/** One local DSH entry; credential material is stored by reference. */
export type LocalDshSettings = z.infer<typeof server>
/** Fully resolved GUI-managed settings. */
export interface ManagedMcpSettings {
  readonly version: 2
  readonly directory: string
  readonly identityFile: string
  readonly services: readonly LocalServiceConfig[]
  readonly servers: readonly LocalDshSettings[]
}

/**
 * Validate managed settings and resolve local paths.
 * @param input - configuration JSON.
 * @param parent - owning configuration directory.
 * @returns validated absolute local settings.
 */
export function parseManagedMcpSettings(input: unknown, parent: string): ManagedMcpSettings {
  try {
    const parsed = schema.parse(input)
    const ids = new Set<string>()
    const origins = new Set<string>()
    const servers = parsed.servers.map((entry) => {
      if (ids.has(entry.id) || origins.has(entry.origin)) throw new Error('Ambiguous DSH entry')
      ids.add(entry.id)
      origins.add(entry.origin)
      return { ...entry, ...(entry.caFile === undefined ? {} : { caFile: resolve(parent, entry.caFile) }) }
    })
    const directory = resolve(parent, parsed.directory)
    return { version: 2, directory, identityFile: resolve(parent, parsed.identityFile),
      services: resolveLocalServices(parsed.services, directory), servers }
  } catch (_error) {
    // JSON fields can contain downstream credentials; expose only a fixed diagnostic.
    throw new Error('Invalid managed MCP configuration')
  }
}
