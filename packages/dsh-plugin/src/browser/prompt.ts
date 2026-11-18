/** Observe the existing HTTP carrier's reads without consuming or replacing its prompt envelope. */
import type { IncomingMessage } from 'node:http'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import { promptAdmissionId, type PromptAdmissionId } from '../host/index.ts'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Retain bounded byte references while the original carrier reads the body.
 * @param request - authenticated prompt request still owned by Connection.
 * @param maxBytes - explicit complete-envelope byte limit.
 * @returns exact prompt identity after end, plus removal of this observer's listeners.
 */
export function observePrompt(request: IncomingMessage, maxBytes: number): {
  identity(): PromptAdmissionId | undefined
  dispose(): void
} {
  const chunks: Buffer[] = []
  let size = 0
  let identity: PromptAdmissionId | undefined
  const data = (value: unknown): void => {
    const chunk = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : undefined
    if (chunk === undefined || size + chunk.byteLength > maxBytes) {
      chunks.length = 0
      request.destroy()
      return
    }
    size += chunk.byteLength
    chunks.push(chunk)
  }
  const end = (): void => {
    try {
      const admitted = clientRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (!admitted.success || admitted.data.method !== 'session/prompt') return
      const input = object(object(object(admitted.data.payload)?.['args'])?.['request'])
      if (typeof input?.['sessionId'] === 'string' && typeof input['requestId'] === 'string') {
        identity = promptAdmissionId(input['sessionId'], input['requestId'])
      }
    } catch (_error) {
      // Connection owns malformed JSON responses; no identity is admitted from invalid bytes.
    } finally { chunks.length = 0 }
  }
  request.on('data', data)
  request.once('end', end)
  request.pause()
  return {
    identity: () => identity,
    dispose() {
      request.off('data', data)
      request.off('end', end)
      chunks.length = 0
    },
  }
}
