/** Bounded JSON admission for the versioned MCP proxy aggregation channel. */
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { EndpointId, AssociationRequestId } from './associations.ts'
import type { InvocationId } from './invocations.ts'

/** Identity of one authenticated socket generation. */
export type GenerationId = Branded<'McpProxyGenerationId'>
/** Local identity of one configured DSH deployment. */
export type DshConnectionId = Branded<'McpProxyDshConnectionId'>
/** Non-reusable downstream client identity within a catalog. */
export type ServiceIncarnationId = Branded<'McpProxyServiceIncarnationId'>
/** Immutable tool catalog revision. */
export type CatalogRevision = Branded<'McpProxyCatalogRevision'>
/** One tool-initiated callback, correlated with its parent invocation. */
export type CallbackId = Branded<'McpProxyCallbackId'>

const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const generation = identity.transform(value => value as GenerationId)
const invocation = identity.transform(value => value as InvocationId)
const revision = identity.transform(value => value as CatalogRevision)
const callback = identity.transform(value => value as CallbackId)
const endpoint = identity.transform(value => value as EndpointId)
const association = identity.transform(value => value as AssociationRequestId)
const jsonObject = z.record(z.string(), z.json())
const service = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)

/** Service-qualified tool descriptor; extension fields retain their original JSON values. */
export const ProxyToolSchema = z.object({
  service,
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: jsonObject,
  outputSchema: jsonObject.optional(),
  annotations: jsonObject.optional(),
  execution: jsonObject.optional(),
  _meta: jsonObject.optional(),
}).catchall(z.json())

/** Validated descriptor supplied by a configured local MCP service. */
export type ProxyTool = z.infer<typeof ProxyToolSchema>

const result = z.object({
  content: z.array(jsonObject),
  structuredContent: z.json().optional(),
  isError: z.boolean().optional(),
  _meta: jsonObject.optional(),
}).catchall(z.json())

const catalog = z.strictObject({
  v: z.literal(1), kind: z.literal('catalog'), revision,
  services: z.array(z.strictObject({ service, instructions: z.string().optional(), serverInfo: jsonObject.optional(),
    incarnation: identity.transform(value => value as ServiceIncarnationId).optional(),
    directory: z.string().min(1).optional(), roots: z.array(z.url().refine(value => new URL(value).protocol === 'file:')).optional(),
  })),
  tools: z.array(ProxyToolSchema),
}).superRefine((value, context) => {
  const services = new Set<string>()
  const tools = new Set<string>()
  for (const entry of value.services) {
    if (services.has(entry.service)) context.addIssue({ code: 'custom', message: 'Duplicate service' })
    services.add(entry.service)
  }
  for (const tool of value.tools) {
    const key = JSON.stringify([tool.service, tool.name])
    if (!services.has(tool.service) || tools.has(key)) context.addIssue({ code: 'custom', message: 'Invalid tool referent or duplicate identity' })
    tools.add(key)
  }
})

const schema = z.discriminatedUnion('kind', [
  z.strictObject({ v: z.literal(1), kind: z.literal('challenge'), generation, nonce: identity, origin: z.url() }),
  z.strictObject({ v: z.literal(1), kind: z.literal('register'), endpointId: endpoint, publicKey: z.string().min(1), signature: z.string().min(1) }),
  z.strictObject({ v: z.literal(1), kind: z.literal('ready'), endpointId: endpoint, generation }),
  catalog,
  z.strictObject({ v: z.literal(1), kind: z.literal('catalog-accepted'), revision }),
  z.strictObject({ v: z.literal(1), kind: z.literal('catalog-rejected'), revision, code: z.enum(['invalid-catalog', 'conflict', 'unavailable']) }),
  z.strictObject({ v: z.literal(1), kind: z.literal('invoke'), id: invocation, generation, revision, service, name: z.string().min(1), args: jsonObject, timeoutMs: z.number().int().positive().max(2_147_483_647) }),
  z.strictObject({ v: z.literal(1), kind: z.literal('result'), id: invocation, generation, result }),
  z.strictObject({ v: z.literal(1), kind: z.literal('failure'), id: invocation, generation, code: z.enum(['unavailable', 'failed', 'unknown', 'cancelled']), message: z.string() }),
  z.strictObject({ v: z.literal(1), kind: z.literal('cancel'), id: invocation, generation }),
  z.strictObject({ v: z.literal(1), kind: z.literal('callback'), id: callback, parent: invocation, generation, method: z.enum(['sampling', 'elicitation']), params: jsonObject }),
  z.strictObject({ v: z.literal(1), kind: z.literal('callback-cancel'), id: callback, parent: invocation, generation }),
  z.strictObject({ v: z.literal(1), kind: z.literal('callback-result'), id: callback, parent: invocation, generation, response: jsonObject }),
  z.strictObject({ v: z.literal(1), kind: z.literal('callback-failure'), id: callback, parent: invocation, generation, code: z.enum(['failed', 'cancelled', 'expired', 'unsupported', 'unknown']) }),
  z.strictObject({ v: z.literal(1), kind: z.literal('association'), requestId: association }),
  z.strictObject({ v: z.literal(1), kind: z.literal('ping') }),
  z.strictObject({ v: z.literal(1), kind: z.literal('pong') }),
])

/** Admitted aggregation message; switching on kind must cover the complete union. */
export type ProxyFrame = z.infer<typeof schema>

/**
 * Hash catalog contents with canonical object-key ordering.
 * @param catalog - validated immutable catalog.
 * @returns a fingerprint independent of JSON object property order.
 */
export function catalogFingerprint(catalog: Extract<ProxyFrame, { kind: 'catalog' }>): string {
  const text = JSON.stringify(catalog, (_key, value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Parse a complete text frame before any protocol state is mutated.
 * @param json - untrusted serialized frame, never included in diagnostics.
 * @param maxBytes - deployment-resolved positive UTF-8 message limit.
 * @returns validated frame preserving JSON extension fields; throws on invalid or oversized input.
 */
export function decodeFrame(json: string, maxBytes: number): ProxyFrame {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('frame byte limit must be a positive safe integer')
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error('MCP proxy frame exceeds byte limit')
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (_error) {
    // Do not include the parser's excerpt of untrusted data in diagnostics.
    throw new Error('Invalid MCP proxy JSON')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid MCP proxy frame')
  return parsed.data
}
