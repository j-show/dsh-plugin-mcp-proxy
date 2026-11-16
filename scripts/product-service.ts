/** Conservative machine service pre/post checks. Never sends stop to a pre-existing owner. */
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

/** Include result cleanup/publication inside the same cross-process run lock. */
export async function withProductRunLock<T>(run: () => Promise<T>, file = join(tmpdir(), 'dsh-mcp-proxy-product-run'), waitMs = 1000): Promise<T> {
  return withFileLock(file, run, { waitMs })
}

export async function assertProductServiceIdle(address?: string): Promise<void> {
  if (!address) address = process.platform === 'win32' ? '\\\\.\\pipe\\dsh-mcp-proxy' : '/tmp/dsh-mcp-proxy/service.sock'
  const socket = createConnection(address)
  const closed = new Promise<void>(resolve => { socket.once('close', resolve) })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => reject(new Error('Product tests require an unused machine service slot')))
      socket.once('error', (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(); else reject(error) })
      socket.setTimeout(2000, () => reject(new Error('Cannot verify idle product service slot')))
    })
  } finally { socket.destroy(); await closed }
}
export async function withProductServiceCheck<T>(run: () => Promise<T>, check: () => Promise<void> = assertProductServiceIdle): Promise<T> {
  await check()
  try { return await run() } finally { await check() }
}
export function verifyProductResults(value: unknown, expected = 5): void {
  if (typeof value !== 'object' || value === null) throw new Error('Missing native product test results')
  const result = value as Record<string, unknown>
  if (result.success !== true || result.numTotalTests !== expected || result.numPassedTests !== expected || result.numFailedTests !== 0 || result.numPendingTests !== 0) throw new Error(`All ${expected} native product cases must pass with zero skips`)
}
