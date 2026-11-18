import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { AssociationStore, ProxyIdentity, pairingChallenge, type BrowserBindingId } from '@jshow/app-mcp-proxy/protocol'
import { DeviceRegistry } from '../../src/host/devices.ts'
import { DevicePairing } from '../../src/host/pairing.ts'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

it('redeems one browser ticket for one proved device without allowing a replay or another browser finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-pairing-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const registry = await DeviceRegistry.open({ filename: join(root, 'devices.json'), origin: 'https://a.example',
    maxDevices: 8, maxBytes: 65536, lockTimeoutMs: 5000 })
  let now = 1000
  const associations = new AssociationStore({ capacity: 8, challengeLifetimeMs: 1000, grantLifetimeMs: 1000 }, () => now)
  const pairing = new DevicePairing({ origin: 'https://a.example', capacity: 8, maxFrameBytes: 65536 }, registry, () => now,
    (id) =>{  associations.assertPending(id) })
  const browser = 'browser-a' as BrowserBindingId
  const request = associations.begin(browser)
  pairing.issue(request)
  const device = ProxyIdentity.generate()
  const proof = device.registration(pairingChallenge('https://a.example', request.requestId), 'https://a.example')
  await expect(pairing.redeem(request.requestId, device.registration(pairingChallenge('https://other.example', request.requestId),
    'https://other.example'))).rejects.toThrow()
  expect(registry.allows(device.endpointId)).toBe(false)
  const outcomes = await Promise.allSettled([pairing.redeem(request.requestId, proof), pairing.redeem(request.requestId, proof)])
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(pairing.owns(request.requestId, device.endpointId)).toBe(true)
  expect(pairing.owns(request.requestId, ProxyIdentity.generate().endpointId)).toBe(false)
  expect(registry.allows(device.endpointId)).toBe(true)
  expect(() => associations.finish(request.requestId, browser)).toThrow()
  associations.confirm(request.requestId, device.endpointId)
  expect(() => associations.finish(request.requestId, 'other-browser' as BrowserBindingId)).toThrow()
  expect(associations.finish(request.requestId, browser).handle).toBeTruthy()
  const expired = associations.begin(browser)
  pairing.issue(expired)
  now += 1001
  await expect(pairing.redeem(expired.requestId, device.registration(pairingChallenge('https://a.example', expired.requestId),
    'https://a.example'))).rejects.toThrow()
  const delayed = associations.begin(browser)
  pairing.issue(delayed)
  const lateDevice = ProxyIdentity.generate()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const holder = withFileLock(join(root, 'devices.json'), async () => { entered.resolve(undefined); await release.promise }, { waitMs: 5000 })
  await entered.promise
  const redemption = pairing.redeem(delayed.requestId, lateDevice.registration(pairingChallenge('https://a.example', delayed.requestId),
    'https://a.example'))
  const rejected = expect(redemption).rejects.toThrow()
  now += 1001
  release.resolve(undefined)
  await holder
  await rejected
  expect(registry.allows(lateDevice.endpointId)).toBe(false)
  expect((await DeviceRegistry.open({ filename: join(root, 'devices.json'), origin: 'https://a.example',
    maxDevices: 8, maxBytes: 65536, lockTimeoutMs: 5000 })).allows(lateDevice.endpointId)).toBe(false)
})
