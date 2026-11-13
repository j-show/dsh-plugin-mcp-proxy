/** Serialize singleton acceptance and refuse a pre-existing product service. */
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { machineControlAddress } from '../src/control.ts'

/** @param address - private control address. @returns no owner was listening. */
export async function assertServiceSlotAvailable(address: string): Promise<void> {
  const socket = createConnection({ path: address })
  const closed = new Promise<void>((resolve) => { socket.once('close', resolve) })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => { reject(new Error('Local MCP acceptance requires an unused service slot')) })
      socket.once('error', (error) => {
        if ('code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) resolve()
        else reject(error)
      })
      socket.setTimeout(2000, () => { reject(new Error('Local MCP acceptance control probe timed out')) })
    })
  } finally { socket.destroy(); await closed }
}

/** @returns release to call only after all owned service/process cleanup has finished. */
export async function acquireServiceSlot(): Promise<() => Promise<void>> {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const held = withFileLock(join(tmpdir(), 'dsh-mcp-proxy-acceptance'), async () => {
    await assertServiceSlotAvailable(await machineControlAddress())
    entered.resolve(undefined)
    await released.promise
  }, { waitMs: 120000 })
  void held.catch((error: unknown) => { entered.reject(error) })
  await entered.promise
  return async () => { released.resolve(undefined); await held }
}
