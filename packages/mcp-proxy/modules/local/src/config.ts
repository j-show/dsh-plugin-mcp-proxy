/** Local-only MCP service configuration, resolved before spawning or connecting. */
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'

const alias = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)
const base = { service: alias, cwd: z.string().optional(), roots: z.array(z.string()).optional() }
const network = { ...base, url: z.url().refine((value) => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
}), headers: z.record(z.string(), z.string()).default({}) }
const schema = z.array(z.discriminatedUnion('transport', [
  z.strictObject({ ...base, transport: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}) }),
  z.strictObject({ ...network, transport: z.literal('streamable-http') }),
  z.strictObject({ ...network, transport: z.literal('sse') }),
]))

type ParsedService = z.infer<typeof schema>[number]
/** Configured service with an absolute working directory and explicit roots. */
export type LocalServiceConfig = ParsedService & { readonly cwd: string; readonly roots: readonly string[] }

/**
 * Validate local configuration without including credentials in diagnostics.
 * @param input - parsed local configuration value.
 * @param directory - absolute local configuration working directory.
 * @returns resolved service entries; throws before connecting on invalid fields or aliases.
 */
export function resolveLocalServices(input: unknown, directory: string): LocalServiceConfig[] {
  const parsed = schema.safeParse(input)
  if (!parsed.success || !isAbsolute(directory)) throw new Error('Invalid local MCP configuration')
  const aliases = new Set<string>()
  return parsed.data.map((entry) => {
    if (aliases.has(entry.service)) throw new Error('Invalid local MCP configuration: duplicate service alias')
    aliases.add(entry.service)
    const cwd = entry.cwd === undefined ? directory : resolve(directory, entry.cwd)
    const roots = entry.roots === undefined ? [cwd] : entry.roots.map(root => resolve(directory, root))
    return { ...entry, cwd, roots }
  })
}
