import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { ManagedSettingsStore } from '@j-show/mcp-proxy-runtime/desktop'
import { applyBundledConnections } from '../src/bundled-connections.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-bundled-connections-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const store = await ManagedSettingsStore.open({ filename: join(root, 'settings.json'), directory: root,
    identityFile: join(root, 'identity.yaml'), legacyIdentityRef: 'LEGACY', waitMs: 5000 })
  await store.update(s => ({ ...s, services: [{ service: 'files', transport: 'stdio', command: process.execPath,
    args: [], env: {}, cwd: root, roots: [root] }] }))
  const certificate = await readFile(new URL('../modules/runtime/tests/fixtures/localhost-cert.pem', import.meta.url), 'utf8')
  const filename = join(root, 'connections.json'), certificates = join(root, 'trust')
  return { root, store, certificate, filename, certificates }
}

it('starts with unchanged settings when no deployment connections are bundled', async () => {
  const f = await fixture(), before = await f.store.read()
  await applyBundledConnections(f.filename, f.certificates, f.store)
  expect(await f.store.read()).toEqual(before)
})

it('automatically installs origin-specific trust without connecting or changing local MCP configuration', async () => {
  const f = await fixture()
  await writeFile(f.filename, JSON.stringify([{ origin: 'https://127.0.0.1:18431', certificate: f.certificate }]))
  const before = await f.store.read()
  await applyBundledConnections(f.filename, f.certificates, f.store)
  const after = await f.store.read()
  expect(after.directory).toBe(before.directory)
  expect(after.identityFile).toBe(before.identityFile)
  expect(after.services).toEqual(before.services)
  expect(after.servers).toHaveLength(1)
  const server = after.servers[0]!
  expect(server).toMatchObject({ origin: 'https://127.0.0.1:18431', mode: 'device', enabled: false })
  expect(await readFile(server.caFile!, 'utf8')).toContain('-----BEGIN CERTIFICATE-----')
  await applyBundledConnections(f.filename, f.certificates, f.store)
  expect(await f.store.read()).toEqual(after)
})

it('preserves explicit trust and manual disconnect intent for existing origins', async () => {
  const f = await fixture()
  await writeFile(f.filename, JSON.stringify([{ origin: 'https://127.0.0.1:18431', certificate: f.certificate }]))
  await applyBundledConnections(f.filename, f.certificates, f.store)
  await f.store.update(s => ({ ...s, servers: s.servers.map(server => ({ ...server, enabled: false, caFile: join(f.root, 'custom.pem') })) }))
  const before = await f.store.read()
  await applyBundledConnections(f.filename, f.certificates, f.store)
  expect(await f.store.read()).toEqual(before)
})

it.each(['http://localhost:18431', 'https://localhost:18431/path'])('rejects invalid deployment origins %s before changing settings', async (origin) => {
  const f = await fixture(), before = await f.store.read()
  await writeFile(f.filename, JSON.stringify([{ origin, certificate: f.certificate }]))
  await expect(applyBundledConnections(f.filename, f.certificates, f.store)).rejects.toThrow('bundled connection')
  expect(await f.store.read()).toEqual(before)
})

it('rejects duplicate origins and private-key material before changing settings', async () => {
  const f = await fixture(), before = await f.store.read()
  const entry = { origin: 'https://127.0.0.1:18431', certificate: f.certificate }
  for (const input of [[entry, entry], [{ ...entry, certificate: f.certificate + '\n-----BEGIN PRIVATE KEY-----\n' }]]) {
    await writeFile(f.filename, JSON.stringify(input))
    await expect(applyBundledConnections(f.filename, f.certificates, f.store)).rejects.toThrow('bundled connection')
    expect(await f.store.read()).toEqual(before)
  }
})

it('refuses a modified public certificate rather than replacing its contents silently', async () => {
  const f = await fixture()
  await writeFile(f.filename, JSON.stringify([{ origin: 'https://127.0.0.1:18431', certificate: f.certificate }]))
  await applyBundledConnections(f.filename, f.certificates, f.store)
  const before = await f.store.read(), caFile = before.servers[0]!.caFile!
  await writeFile(caFile, 'changed by owner')
  await expect(applyBundledConnections(f.filename, f.certificates, f.store)).rejects.toThrow('differs')
  expect(await readFile(caFile, 'utf8')).toBe('changed by owner')
  expect(await f.store.read()).toEqual(before)
})
