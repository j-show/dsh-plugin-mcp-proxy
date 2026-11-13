/** Kernel ownership for the Unix control socket, retained across listener startup and teardown. */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

/** A descriptor whose closure releases the kernel lock, including process termination. */
export interface UnixControlLease {
  /** @returns after closing the descriptor; repeated release joins the same completion. */
  release(): Promise<void>
}
/**
 * Acquire the kernel lease for the fixed Unix control listener.
 * @param filename - private stable lock inode, never unlinked.
 * @returns held kernel lock.
 */
export async function acquireUnixControlLease(filename: string): Promise<UnixControlLease> {
  const handle = await open(filename, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const initial = await handle.stat({ bigint: true })
    const uid = process.getuid?.()
    if (!initial.isFile() || (process.platform !== 'win32'
      && (uid === undefined || initial.uid !== BigInt(uid) || (initial.mode & 0o077n) !== 0n))) throw new Error('Private Unix control lock required')
    try { await tryLockExclusive(handle.fd) } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')) {
        throw new Error('Local mcp-proxy service is already running')
      }
      throw error
    }
    const current = await lstat(filename, { bigint: true })
    if (current.isSymbolicLink() || current.ino !== initial.ino || current.dev !== initial.dev) throw new Error('Unix control lock inode changed')
  } catch (error) { await handle.close(); throw error }
  let released: Promise<void> | undefined
  return { release: () => released ??= handle.close() }
}
