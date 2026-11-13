import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { ManagedSettingsStore } from '../src/settings-store.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'proxy-settings-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return { filename: join(root, 'settings.json'), directory: join(root, 'workspace'), identityFile: join(root, 'identity.yaml'),
    legacyIdentityRef: 'LEGACY_KEY', waitMs: 5000 }
}

it('initializes empty GUI settings without needing a server or creating credentials', async () => {
  const options = await fixture()
  const store = await ManagedSettingsStore.open(options)
  expect(await store.read()).toMatchObject({ version: 2, servers: [], services: [], directory: options.directory })
  await expect(readFile(options.identityFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('migrates a legacy origin while preserving the exact original file and resolved local paths', async () => {
  const options = await fixture()
  const original = JSON.stringify({ server: { origin: 'https://legacy.example', credentialRef: 'DEPLOYMENT' },
    directory: 'existing', identityFile: 'keys.yaml', services: [] })
  await writeFile(options.filename, original, { mode: 0o600 })
  const store = await ManagedSettingsStore.open(options)
  const settings = await store.read()
  expect(settings.servers[0]).toMatchObject({ mode: 'legacy', origin: 'https://legacy.example', identityRef: 'LEGACY_KEY' })
  expect(settings.directory).toBe(join(options.directory, '..', 'existing'))
  expect(await readFile(options.filename + '.v1.bak', 'utf8')).toBe(original)
})

it('serializes independent writers and preserves the previous file on rejected updates', async () => {
  const options = await fixture()
  const a = await ManagedSettingsStore.open(options)
  const b = await ManagedSettingsStore.open(options)
  await Promise.all([a, b].map((store, index) => store.update(state => ({ ...state, servers: [...state.servers, {
    id: `server-${index}`, origin: `https://dsh-${index}.example`, enabled: true, mode: 'device', identityRef: `DEVICE_${index}`,
  }] }))))
  expect((await a.read()).servers).toHaveLength(2)
  const before = await readFile(options.filename, 'utf8')
  await expect(a.update(state => ({ ...state, servers: [{ id: 'bad', origin: 'http://bad.example' }] }))).rejects.toThrow()
  expect(await readFile(options.filename, 'utf8')).toBe(before)
})

it('reports invalid existing settings without overwriting them with defaults', async () => {
  const options = await fixture()
  await writeFile(options.filename, '{ private-config', { mode: 0o600 })
  await expect(ManagedSettingsStore.open(options)).rejects.toThrow('Invalid managed MCP configuration')
  expect(await readFile(options.filename, 'utf8')).toBe('{ private-config')
})
