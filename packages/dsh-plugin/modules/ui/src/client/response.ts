/** Bounded browser JSON parsing with reader ownership through cancellation. */
/**
 * Reject decoded values that are not JSON objects.
 * @param value - untrusted decoded JSON.
 * @returns an object or a fixed parser error.
 */
export function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid association response')
  return value as Record<string, unknown>
}

/**
 * Validate a JSON response object before reading its fields.
 * @param response - browser response whose body belongs to this operation.
 * @param limit - maximum complete UTF-8 response bytes.
 * @param signal - request and plugin cancellation.
 * @returns decoded JSON object; errors never repeat the payload.
 */
export async function responseObject(response: Response, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('Missing association response')
  let cancelling: Promise<void> | undefined
  const cancel = (): void => {
    cancelling ??= reader.cancel().catch((_error: unknown) => {
      // A transport may already have closed; the reader is still released below.
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > limit) { await reader.cancel(); throw new Error('Association response exceeds budget') }
      chunks.push(next.value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await cancelling
    reader.releaseLock()
  }
  signal.throwIfAborted()
  const value = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length }
  try { return objectValue(JSON.parse(new TextDecoder().decode(value))) } catch (_error) {
    throw new Error('Invalid association response')
  }
}
