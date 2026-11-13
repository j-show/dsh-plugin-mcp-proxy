import { expect, it } from 'vitest'
import { settleBackgroundOwner } from '../src/background-owner.ts'

it('terminates a remaining process group even after the direct child has exited', async () => {
  let alive = true
  const signals: NodeJS.Signals[] = []
  await settleBackgroundOwner({ rootExited: () => true, alive: () => alive, root: Promise.resolve(),
    signal: (signal) => { signals.push(signal); alive = false },
  }, { graceMs: 1000, reapMs: 1000, pollMs: 1 })
  expect(signals).toEqual(['SIGKILL'])
  expect(alive).toBe(false)
})

it('does not signal an already quiescent process owner', async () => {
  const signals: NodeJS.Signals[] = []
  await settleBackgroundOwner({ rootExited: () => true, alive: () => false, root: Promise.resolve(),
    signal: (signal) => { signals.push(signal) },
  }, { graceMs: 1000, reapMs: 1000, pollMs: 1 })
  expect(signals).toEqual([])
})

it('force-stops a live root and scope after graceful shutdown expires', async () => {
  let exited = false
  const root = Promise.withResolvers<undefined>()
  const signals: NodeJS.Signals[] = []
  await settleBackgroundOwner({ root: root.promise, rootExited: () => exited, alive: () => !exited,
    signal: (signal) => { signals.push(signal); exited = true; root.resolve(undefined) },
  }, { graceMs: 0, reapMs: 1000, pollMs: 1 })
  expect(signals).toEqual(['SIGKILL'])
})

it('rejects a scope that remains alive after its forced-reap deadline', async () => {
  const signals: NodeJS.Signals[] = []
  await expect(settleBackgroundOwner({ root: Promise.resolve(), rootExited: () => true, alive: () => true,
    signal: (signal) => { signals.push(signal) },
  }, { graceMs: 0, reapMs: 1, pollMs: 1 })).rejects.toThrow('Local MCP background cleanup failed')
  expect(signals).toEqual(['SIGKILL'])
})

it('waits for the direct-child exit observation even when its scope is already quiescent', async () => {
  let exited = false
  const root = Promise.withResolvers<undefined>()
  const signals: NodeJS.Signals[] = []
  const cleanup = settleBackgroundOwner({ root: root.promise, rootExited: () => exited, alive: () => false,
    signal: (signal) => { signals.push(signal) },
  }, { graceMs: 1000, reapMs: 1000, pollMs: 1 })
  queueMicrotask(() => { exited = true; root.resolve(undefined) })
  await cleanup
  expect(signals).toEqual([])
})
