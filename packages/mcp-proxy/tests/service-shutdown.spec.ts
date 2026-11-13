import { expect, it, vi } from 'vitest'
import { stopDesktopService } from '../src/service-shutdown.ts'

it('never stops a replacement service or an owner this GUI did not adopt', async () => {
  const stop = vi.fn<() => Promise<void>>()
  await stopDesktopService({ expectedPid: 1, status: async () => ({ pid:2 }), stop, exited: () => true, timeoutMs: 1000, pollMs: 1 })
  await stopDesktopService({ expectedPid: undefined, status: async () => ({ pid: 2 }), stop,
    exited: () => true, timeoutMs: 1000, pollMs: 1 })
  expect(stop).not.toHaveBeenCalled()
})
it('uses the expected PID and waits for both IPC release and process exit', async () => {
  let running = true
  const stop = vi.fn(async (pid:number) => { expect(pid).toBe(7); running = false })
  let observations = 0
  await stopDesktopService({ expectedPid: 7, status: async () => running ? { pid:7 } : undefined, stop,
    exited: () => ++observations > 1, timeoutMs: 1000, pollMs: 1 })
  expect(stop).toHaveBeenCalledExactlyOnceWith(7)
  expect(observations).toBeGreaterThan(1)
})

it('stops its child when control becomes available after Exit was requested', async () => {
  let observations = 0
  let stopped = false
  const stop = vi.fn(async () => { stopped = true })
  await stopDesktopService({ expectedPid: 9, status: async () => ++observations === 1 || stopped ? undefined : { pid: 9 },
    stop, exited: () => stopped, timeoutMs: 1000, pollMs: 1 })
  expect(stop).toHaveBeenCalledExactlyOnceWith(9)
})
