/** Local product configuration loaded before identity storage, server connection or MCP startup. */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { resolveLocalServices, type LocalServiceConfig } from './config.ts'

const schema = z.strictObject({
  server: z.strictObject({
    origin: z.url().refine((value) => {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value
    }),
    credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    caFile: z.string().min(1).optional(),
  }),
  directory: z.string().min(1),
  identityFile: z.string().min(1),
  services: z.array(z.unknown()),
})

/** Resolved local product settings; credentials remain references and downstream configuration stays local. */
export interface McpProxySettings {
  readonly server: { readonly origin: string; readonly credentialRef: string; readonly caFile?: string }
  readonly directory: string
  readonly identityFile: string
  readonly services: readonly LocalServiceConfig[]
}

/**
 * Read strict JSON settings without starting processes or disclosing file/parser contents in errors.
 * @param filename - configuration filename; relative product paths resolve against its parent directory.
 * @returns resolved settings ready for the local runtime's admission step.
 */
export async function readMcpProxySettings(filename: string): Promise<McpProxySettings> {
  try {
    const file = resolve(filename)
    const parsed = schema.parse(JSON.parse(await readFile(file, 'utf8')))
    const directory = resolve(dirname(file), parsed.directory)
    return { server: { origin: parsed.server.origin, credentialRef: parsed.server.credentialRef,
      ...(parsed.server.caFile === undefined ? {} : { caFile: resolve(dirname(file), parsed.server.caFile) }),
    }, directory, identityFile: resolve(dirname(file), parsed.identityFile),
    services: resolveLocalServices(parsed.services, directory),
    }
  } catch (_error) {
    // File paths, parser excerpts and downstream environment values can contain private information.
    throw new Error('Invalid or unreadable mcp-proxy configuration')
  }
}
