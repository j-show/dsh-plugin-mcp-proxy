/** Successful configuration settlement can race owner disposal before apply resumes. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime, SlotRegistry } from './support/framework.ts'
import { expect, it, vi, onTestFinished } from 'vitest'
import type { ProxyUiConfig } from '../../src/ui/types.ts'
import type { ProxyFetch } from '../../src/client/controller.ts'
import { apply, inject } from '../../src/client/index.ts'

const pending = vi.hoisted(() => ({
  entered: Promise.withResolvers<undefined>(), configuration: Promise.withResolvers<ProxyUiConfig>(),
  signal: undefined as AbortSignal | undefined,
}))
vi.mock('../../src/client/config.ts', () => ({
  readUiConfig: (_bootstrap: ProxyUiConfig, _fetch: ProxyFetch, signal: AbortSignal) => {
    pending.signal = signal
    pending.entered.resolve(undefined)
    return pending.configuration.promise
  },
}))

it('does not register late UI when successful Host validation settles after disposal began', async () => {
  const config = { pollIntervalMs: 500, statusIntervalMs: 15000,
    associationTimeoutMs: 30000, requestTimeoutMs: 10000, maxResponseBytes: 65536 }
  const ctx = new Context()
  onTestFinished(async () => { pending.configuration.resolve(config); await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await pending.entered.promise
  const disposed = fiber.dispose()
  expect(pending.signal?.aborted).toBe(true)
  pending.configuration.resolve(config)
  await disposed
  const slots = ctx.get('slots') as SlotRegistry
  expect(slots.entries('settings.section')).toHaveLength(0)
  expect(slots.entries('conversation.input.dock')).toHaveLength(0)
})
