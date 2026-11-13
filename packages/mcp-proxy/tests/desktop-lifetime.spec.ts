import { expect, it, vi } from 'vitest'
import { DesktopLifetime } from '../src/desktop-lifetime.ts'

it('hides the window without stopping service and coalesces Exit until shutdown completes', async () => {
  const surface = { show: vi.fn(), hide: vi.fn(), focus: vi.fn() }
  const stopped = Promise.withResolvers<undefined>()
  const stop = vi.fn(() => stopped.promise)
  const quit = vi.fn()
  const lifetime = new DesktopLifetime(surface, stop, quit)
  lifetime.closeWindow()
  expect(surface.hide).toHaveBeenCalledOnce()
  expect(stop).not.toHaveBeenCalled()
  lifetime.showWindow()
  expect(surface.show).toHaveBeenCalledOnce()
  expect(surface.focus).toHaveBeenCalledOnce()
  const first = lifetime.exit()
  const second = lifetime.exit()
  expect(first).toBe(second)
  expect(quit).not.toHaveBeenCalled()
  stopped.resolve(undefined)
  await first
  expect(stop).toHaveBeenCalledOnce()
  expect(quit).toHaveBeenCalledOnce()
})
