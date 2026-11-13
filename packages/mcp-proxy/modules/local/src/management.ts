/** Narrow JSON commands and redacted snapshots across the desktop/process IPC. */
import { z } from 'zod'
import type { DshConnectionId } from '@j-show/mcp-proxy-protocol'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const dsh = id.transform(value => value as DshConnectionId)
const origin = z.url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value })
const service = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)
const command = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snapshot') }),
  z.strictObject({ kind: z.literal('disconnect'), id: dsh }),
  z.strictObject({ kind: z.literal('add-mcp'), service: z.unknown() }),
  z.strictObject({ kind: z.literal('remove-mcp'), service }),
  z.strictObject({ kind: z.literal('activate'), uri: z.string().min(1).max(4096) }),
])
const snapshot = z.strictObject({ version: z.literal(2), pid: z.number().int().positive(), directory: z.string().min(1),
  settingsFile: z.string().min(1),
  servers: z.array(z.strictObject({ id: dsh, origin, state: z.enum(['connecting','connected','reconnecting','disconnected','error']) })),
  services: z.array(z.strictObject({ service, transport: z.enum(['stdio','streamable-http','sse']), ready: z.boolean() })),
})
const reply = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), snapshot }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['invalid-request','operation-failed','restart-required','pairing-failed']) })])

/** Allowed local administration request; execution remains in the dsh profile. */
export type LocalManagementCommand = z.infer<typeof command>
/** Redacted state; neither credentials nor MCP launch/environment values cross into the renderer. */
export type LocalDesktopSnapshot = z.infer<typeof snapshot>
/** Typed administration outcome without raw exception messages. */
export type LocalManagementReply = z.infer<typeof reply>

/**
 * Validate the allowlisted desktop IPC command.
 * @param input - untrusted IPC command.
 * @returns validated allowlisted operation.
 */
export function parseLocalManagementCommand(input: unknown): LocalManagementCommand {
  const parsed = command.safeParse(input)
  if (!parsed.success) throw new Error('Invalid local management request')
  return parsed.data
}
/**
 * Validate a redacted desktop IPC response.
 * @param input - IPC response.
 * @returns strictly redacted renderer data.
 */
export function parseLocalManagementReply(input: unknown): LocalManagementReply {
  const parsed = reply.safeParse(input)
  if (!parsed.success) throw new Error('Invalid local management reply')
  return parsed.data
}
