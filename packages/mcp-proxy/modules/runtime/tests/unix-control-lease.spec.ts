import { expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { readSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const native = vi.hoisted(() => ({ lock: vi.fn<(fd: number) => Promise<void>>() }))
vi.mock('@deepseek-ai/node-addon-system/flock', () => ({ tryLockExclusive: native.lock }))
import { acquireUnixControlLease } from '../src/unix-control-lease.ts'

async function filename() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-control-lease-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  onTestFinished(() => { native.lock.mockReset() })
  return join(root, 'owner.lock')
}

it('holds the verified lock descriptor until explicit idempotent release', async () => {
  const path = await filename()
  native.lock.mockResolvedValue(undefined)
  const lease = await acquireUnixControlLease(path)
  onTestFinished(() => lease.release())
  const fd = native.lock.mock.calls[0]![0]
  expect(readSync(fd, Buffer.alloc(1), 0, 1, 0)).toBe(0)
  await lease.release()
  await lease.release()
  expect(() => readSync(fd, Buffer.alloc(1), 0, 1, 0)).toThrow()
})

it('closes a descriptor when the kernel refuses a concurrent owner', async () => {
  const path = await filename()
  native.lock.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EWOULDBLOCK' }))
  await expect(acquireUnixControlLease(path)).rejects.toThrow('already running')
  const fd = native.lock.mock.calls[0]![0]
  expect(() => readSync(fd, Buffer.alloc(1), 0, 1, 0)).toThrow()
})

it('refuses a replaced lock inode and closes the orphaned descriptor', async () => {
  const path = await filename()
  native.lock.mockImplementation(async () => {
    await rename(path, path + '.old')
    await writeFile(path, '')
  })
  await expect(acquireUnixControlLease(path)).rejects.toThrow('changed')
  const fd = native.lock.mock.calls[0]![0]
  expect(() => readSync(fd, Buffer.alloc(1), 0, 1, 0)).toThrow()
})
