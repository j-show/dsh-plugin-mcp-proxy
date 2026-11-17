import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { ProxyIdentity } from '@jshow/app-mcp-proxy/protocol'
import { DeviceRegistry } from '../src/devices.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proxy-devices-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { filename: join(root, 'devices.json'), origin: 'https://a.example', maxDevices: 2, maxBytes: 65536, lockTimeoutMs: 5000 }
}

it('persists registered public identities and revocation across plugin restarts', async () => {
  const options = await fixture()
  const identity = ProxyIdentity.generate()
  const registry = await DeviceRegistry.open(options)
  expect(registry.allows(identity.endpointId)).toBe(false)
  await registry.register(identity)
  expect(registry.allows(identity.endpointId)).toBe(true)
  expect((await DeviceRegistry.open(options)).allows(identity.endpointId)).toBe(true)
  await expect(DeviceRegistry.open({ ...options, origin: 'https://other.example' })).rejects.toThrow('Invalid MCP device registry')
  expect(await readFile(options.filename, 'utf8')).not.toContain('PRIVATE KEY')
  await registry.revoke(identity.endpointId)
  const restarted = await DeviceRegistry.open(options)
  expect(restarted.allows(identity.endpointId)).toBe(false)
  await expect(restarted.register(identity)).rejects.toThrow('revoked')
})

it('preserves independently registered devices and refuses quota exhaustion without replacement', async () => {
  const options = await fixture()
  const a = await DeviceRegistry.open(options)
  const b = await DeviceRegistry.open(options)
  const first = ProxyIdentity.generate()
  const second = ProxyIdentity.generate()
  await Promise.all([a.register(first), b.register(second)])
  const reopened = await DeviceRegistry.open(options)
  expect(reopened.allows(first.endpointId)).toBe(true)
  expect(reopened.allows(second.endpointId)).toBe(true)
  await expect(reopened.register(ProxyIdentity.generate())).rejects.toThrow()
  const after = await DeviceRegistry.open(options)
  expect(after.allows(first.endpointId)).toBe(true)
  expect(after.allows(second.endpointId)).toBe(true)
})

it('rejects corrupt existing storage without replacing it with an empty registry', async () => {
  const options = await fixture()
  await writeFile(options.filename, '{ corrupt', { mode: 0o600 })
  await expect(DeviceRegistry.open(options)).rejects.toThrow('Invalid MCP device registry')
  expect(await readFile(options.filename, 'utf8')).toBe('{ corrupt')
})
