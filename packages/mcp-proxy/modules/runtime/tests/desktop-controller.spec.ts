import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { proxyActivationUri, type AssociationRequestId, type DshConnectionId } from '@j-show/mcp-proxy-protocol'
import { parseLocalManagementReply } from '@j-show/mcp-proxy-local'
import { ManagedSettingsStore } from '../src/settings-store.ts'
import { ManagedLocalRuntime } from '../src/managed-runtime.ts'
import { DesktopController, type DesktopDevicePairer } from '../src/desktop-controller.ts'

async function fixture(pair: DesktopDevicePairer) {
  const root = await mkdtemp(join(tmpdir(), 'proxy-desktop-controller-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const store = await ManagedSettingsStore.open({ filename: join(root, 'settings.json'), directory: root,
    identityFile: join(root, 'identity.yaml'), legacyIdentityRef: 'OLD_KEY', waitMs: 5000 })
  const associations: string[] = []
  const runtime = await ManagedLocalRuntime.open(store, { pool: { maxServices: 4, maxFrameBytes: 65536, maxDiscoveryPages: 8,
    maxClientRequests: 8, maxClientRequestRecords: 32, startupTimeoutMs: 2000, callTimeoutMs: 2000, taskCancelTimeoutMs: 1000 },
  maxServers: 4, maxInvocations: 32, reconnectDelayMs: 10 }, async (server) => {
    const done = Promise.withResolvers<undefined>()
    return { closed: done.promise, publish: async () => {}, associate: async (id) => { associations.push(`${server.id}:${id}`) },
      close: async () => { done.resolve(undefined) } }
  }, new AbortController().signal)
  onTestFinished(() => runtime.close())
  const controller = new DesktopController(store, runtime, pair, { maxActivations: 16,
    activationLifetimeMs: 10000, connectTimeoutMs: 2000, connectPollMs: 10 }, new AbortController().signal)
  onTestFinished(() => controller.close())
  return { controller, store, associations }
}

it('automatically pairs a first origin and resumes it only after a new activation following manual disconnect', async () => {
  const calls: string[] = []
  const { controller,store,associations } = await fixture(async (activation) => {
    calls.push(activation.origin)
    return { id: 'server' as DshConnectionId, origin: activation.origin, enabled: true, mode: 'device', identityRef: 'DEVICE' }
  })
  const uri = proxyActivationUri('https://dsh.example', 'a'.repeat(43) as AssociationRequestId)
  const begun = parseLocalManagementReply(await controller.handle({ kind: 'activate', uri }))
  if (!begun.ok) throw new Error('Expected automatic pairing')
  expect(calls).toEqual(['https://dsh.example'])
  expect(associations).toEqual(['server:' + 'a'.repeat(43)])
  await controller.handle({ kind: 'disconnect', id: 'server' })
  expect((await store.read()).servers[0]?.enabled).toBe(false)
  expect(await controller.handle({ kind: 'activate', uri })).toMatchObject({ ok: true })
  expect(calls).toHaveLength(1)
  expect((await store.read()).servers[0]?.enabled).toBe(false)
  const repeated = await controller.handle({ kind: 'activate', uri: proxyActivationUri('https://dsh.example',
    'b'.repeat(43) as AssociationRequestId) })
  if (!repeated.ok) throw new Error('Expected known-origin connection')
  expect(calls).toHaveLength(2)
  expect((await store.read()).servers[0]?.enabled).toBe(true)
})

it('keeps another DSH activation responsive while one origin is waiting for network registration', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const { controller } = await fixture(async (activation) => {
    if (activation.origin === 'https://a.example') { entered.resolve(undefined); await release.promise }
    return { id: new URL(activation.origin).hostname.split('.')[0] as DshConnectionId, origin: activation.origin,
      enabled: true, mode: 'device', identityRef: 'DEVICE' }
  })
  onTestFinished(() => { release.resolve(undefined) })
  const pending=controller.handle({ kind:'activate',uri:proxyActivationUri('https://a.example','x'.repeat(43) as AssociationRequestId) })
  await entered.promise
  expect(await controller.handle({ kind:'activate',uri:proxyActivationUri('https://b.example','x'.repeat(43) as AssociationRequestId) }))
    .toMatchObject({ ok:true })
  release.resolve(undefined)
  await pending
})

it('does not undo manual disconnect when an older browser pairing response arrives late', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let calls = 0
  const { controller, store, associations } = await fixture(async (activation) => {
    if (++calls > 1) { entered.resolve(undefined); await release.promise }
    return { id: 'server' as DshConnectionId, origin: activation.origin, enabled: true, mode: 'device', identityRef: 'DEVICE' }
  })
  onTestFinished(() => { release.resolve(undefined) })
  const first = await controller.handle({ kind: 'activate', uri: proxyActivationUri('https://dsh.example', 'a'.repeat(43) as AssociationRequestId) })
  if (!first.ok) throw new Error('Expected automatic pairing')
  const pending = controller.handle({ kind: 'activate', uri: proxyActivationUri('https://dsh.example', 'b'.repeat(43) as AssociationRequestId) })
  await entered.promise
  expect(await controller.handle({ kind: 'disconnect', id: 'server' })).toMatchObject({ ok: true })
  release.resolve(undefined)
  expect(await pending).toMatchObject({ ok: false })
  expect((await store.read()).servers[0]?.enabled).toBe(false)
  expect(associations).toEqual(['server:' + 'a'.repeat(43)])
})
