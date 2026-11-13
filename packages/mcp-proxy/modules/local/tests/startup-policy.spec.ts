import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { LocalMcpPool, resolveLocalServices } from '../src/index.ts'

const options = { maxServices: 4, maxFrameBytes: 65536, maxDiscoveryPages: 8, startupTimeoutMs: 10000,
  callTimeoutMs: 10000, maxClientRequests: 4, maxClientRequestRecords: 32, taskCancelTimeoutMs: 1000 }
afterEach(() => { vi.unstubAllEnvs() })

it('does not implicitly carry bridge Electron flags into downstream MCPs', async () => {
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  vi.stubEnv('CHROME_CRASHPAD_PIPE_NAME', 'unrelated-pipe')
  const root = await mkdtemp(join(tmpdir(), 'proxy-electron-env-'))
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'files', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/files.mjs', import.meta.url))] }], root), options)
  onTestFinished(async () => { await pool.close(); await rm(root, { recursive: true, force: true }) })
  for (const name of ['ELECTRON_RUN_AS_NODE', 'CHROME_CRASHPAD_PIPE_NAME']) {
    expect(await pool.call('files', 'has-env', { name }, new AbortController().signal)).toMatchObject({ structuredContent: { present: false } })
  }
})

it('requires a restart before declaring an already inherited variable as a new DSH credential', async () => {
  vi.stubEnv('REVIEW_DEPLOYMENT_REF', 'synthetic-marker')
  const root = await mkdtemp(join(tmpdir(), 'proxy-credential-policy-'))
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'files', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/files.mjs', import.meta.url))] }], root), options)
  onTestFinished(async () => { await pool.close(); await rm(root, { recursive: true, force: true }) })
  expect(() => pool.excludeCredentialReferences(['REVIEW_DEPLOYMENT_REF'])).toThrow('restart')
  expect(() => pool.excludeCredentialReferences(['PATH'])).toThrow('SDK-inherited')
})

it('rejects a credential reference which the SDK would implicitly restore as an operating-system variable', async () => {
  await expect(LocalMcpPool.open([], options, undefined, { excludeEnvironment: ['PATH'] }))
    .rejects.toThrow('SDK-inherited operating-system variable')
})

it('does not implicitly inherit a credential with a non-sensitive environment name', async () => {
  vi.stubEnv('CONNECT_CREDENTIAL', 'fixture-deployment-value')
  const root = await mkdtemp(join(tmpdir(), 'proxy-startup-policy-'))
  const owned: { pool?: LocalMcpPool } = {}
  onTestFinished(async () => { await owned.pool?.close(); await rm(root, { recursive: true, force: true }) })
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service: 'files', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/files.mjs', import.meta.url))],
  }], root), options, undefined, { excludeEnvironment: ['CONNECT_CREDENTIAL'] })
  owned.pool = pool
  expect(await pool.call('files', 'has-env', { name: 'CONNECT_CREDENTIAL' }, new AbortController().signal))
    .toMatchObject({ structuredContent: { present: false } })
})

it('does not start another MCP after cancellation during the first service startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-startup-cancel-'))
  let pool: LocalMcpPool | undefined
  const release = join(root, 'release')
  onTestFinished(async () => {
    await writeFile(release, 'released')
    await pool?.close()
    await rm(root, { recursive: true, force: true })
  })
  const fixture = fileURLToPath(new URL('./fixtures/blocked-start.mjs', import.meta.url))
  const entered = join(root, 'first')
  const second = join(root, 'second')
  const controller = new AbortController()
  const opening = LocalMcpPool.open(resolveLocalServices([
    { service: 'first', transport: 'stdio', command: process.execPath, args: [fixture, entered, release] },
    { service: 'second', transport: 'stdio', command: process.execPath, args: [fixture, second, release] },
  ], root), options, undefined, { signal: controller.signal }).then((value) => { pool = value; return 'ready' }, () => 'cancelled')
  await expect.poll(async () => {
    try { return await readFile(entered, 'utf8') } catch (_error) { return undefined }
  }, { timeout: 3000 }).toBe('started')
  controller.abort()
  await writeFile(release, 'released')
  expect(await opening).toBe('cancelled')
  await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' })
})
