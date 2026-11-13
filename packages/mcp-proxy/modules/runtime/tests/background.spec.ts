import { expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBackgroundService } from '../src/background.ts'
import { requestLocalStop } from '../src/control.ts'
import { createProcessInspector } from './support/process-inspector.ts'

const callbacks = vi.hoisted(() => ({ afterStatus: undefined as ((status: { pid: number; ready: boolean }) => void) | undefined }))
vi.mock('../src/control.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/control.ts')>('../src/control.ts')
  return { ...actual, requestLocalStatus: async (...args: Parameters<typeof actual.requestLocalStatus>) => {
    const result = await actual.requestLocalStatus(...args)
    callbacks.afterStatus?.(result)
    return result
  } }
})

async function setup(ready = true, fail = false, extra: { descendant?: boolean; ignoreStop?: boolean; foreignStatus?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-background-'))
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\mcp-background-${randomUUID()}` : join(root, 'control.sock')
  const owner: { pid?: number } = {}
  onTestFinished(() => { callbacks.afterStatus = undefined })
  onTestFinished(async () => {
    try {
      let pid = owner.pid
      try {
        const observed = JSON.parse(await readFile(join(root, 'observed.json'), 'utf8')) as { pid: number }
        pid ??= observed.pid
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      }
      if (pid === undefined) return
      const inspector = createProcessInspector()
      const snapshot = inspector.snapshot()
      const identity = snapshot.tree(process.pid).find(entry => entry.pid === pid)
      if (identity === undefined) {
        if (isRunning(pid)) throw new Error('Background fixture process is not owned by this worker')
        return
      }
      const scope = snapshot.tree(identity.pid)
      try {
        try { await requestLocalStop(address, 1000, identity.pid) } catch (_error) { /* Startup may lack a responsive listener. */ }
        await expect.poll(() => scope.some(entry => inspector.isAlive(entry)), { timeout: 5000 }).toBe(false)
      } finally {
        for (const entry of scope) if (inspector.isAlive(entry)) inspector.signalProcess(entry, 'SIGKILL')
        await expect.poll(() => scope.some(entry => inspector.isAlive(entry)), { timeout: 5000 }).toBe(false)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15000)
  const settings = join(root, 'settings.json')
  const observed = join(root, 'observed.json')
  await mkdir(join(root, 'invoking'))
  const cwd = await realpath(join(root, 'invoking'))
  await writeFile(settings, JSON.stringify({ address, observed, ready, fail, ...extra }))
  const spec = { node: process.execPath, cli: fileURLToPath(new URL('./fixtures/background-profile.mjs', import.meta.url)),
    home: root, cwd, profile: 'fixture', profileDir: root, settings, address,
    controlTimeoutMs: 1000, startupTimeoutMs: 10000, pollIntervalMs: 20, shutdownTimeoutMs: 2000,
  }
  return { root, spec, observed, owner }
}

it('detaches the fixed dsh profile only after its own process reports acknowledged readiness', { timeout: 20000 }, async () => {
  const { spec, observed, owner } = await setup()
  const result = await startBackgroundService(spec, new AbortController().signal)
  owner.pid = result.pid
  const received = JSON.parse(await readFile(observed, 'utf8')) as unknown
  expect(received).toEqual({ pid: result.pid, home: spec.home, cwd: spec.cwd,
    args: ['--profile', spec.profile, '--config', spec.settings],
  })
  expect(isRunning(result.pid)).toBe(true)
  await requestLocalStop(spec.address, 1000)
  await expect.poll(() => isRunning(result.pid)).toBe(false)
})

it('rejects an existing local owner without creating another service', { timeout: 20000 }, async () => {
  const { spec, observed, owner } = await setup()
  const first = await startBackgroundService(spec, new AbortController().signal)
  owner.pid = first.pid
  await expect(startBackgroundService(spec, new AbortController().signal)).rejects.toThrow('already running')
  expect(JSON.parse(await readFile(observed, 'utf8')) as unknown).toMatchObject({ pid: first.pid })
})

it('reports early process failure and retains its diagnostics', { timeout: 20000 }, async () => {
  const { root, spec } = await setup(true, true)
  await expect(startBackgroundService(spec, new AbortController().signal)).rejects.toThrow('startup failed')
  expect(await readFile(join(root, 'mcp-proxy.log'), 'utf8')).toContain('fixture startup failed')
})

it('rejects a pre-cancelled start before creating a log or service process', { timeout: 20000 }, async () => {
  const { root, spec, observed } = await setup()
  await expect(startBackgroundService(spec, AbortSignal.abort())).rejects.toThrow()
  await expect(readFile(observed)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(root, 'mcp-proxy.log'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('settles a failed executable spawn without waiting for a nonexistent process', { timeout: 20000 }, async () => {
  const { root, spec, observed } = await setup()
  await expect(startBackgroundService({ ...spec, node: join(root, 'missing-node') }, new AbortController().signal))
    .rejects.toThrow('Local MCP background startup failed')
  await expect(readFile(observed)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a log directory before spawning the background service', { timeout: 20000 }, async () => {
  const { root, spec, observed } = await setup()
  await mkdir(join(root, 'mcp-proxy.log'))
  await expect(startBackgroundService(spec, new AbortController().signal)).rejects.toThrow('Local MCP background startup failed')
  await expect(readFile(observed)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects another process identity in the status response and reaps only its own child', { timeout: 20000 }, async () => {
  const { spec, observed, owner } = await setup(true, false, { foreignStatus: true })
  await expect(startBackgroundService(spec, new AbortController().signal)).rejects.toThrow('Local MCP background startup failed')
  const received = JSON.parse(await readFile(observed, 'utf8')) as { pid: number }
  owner.pid = received.pid
  expect(isRunning(received.pid)).toBe(false)
  expect(isRunning(process.pid)).toBe(true)
})

it('force-stops its own child when cancellation finds an unresponsive control listener', { timeout: 20000 }, async () => {
  const { spec, observed, owner } = await setup(false, false, { ignoreStop: true })
  const stop = new AbortController()
  callbacks.afterStatus = () => { stop.abort() }
  await expect(startBackgroundService(spec, stop.signal)).rejects.toThrow('Local MCP background startup failed')
  const received = JSON.parse(await readFile(observed, 'utf8')) as { pid: number }
  owner.pid = received.pid
  expect(isRunning(received.pid)).toBe(false)
})

it('cancels an owned startup that has acquired its listener without reporting ready', { timeout: 20000 }, async () => {
  const { spec, observed } = await setup(false)
  const stop = new AbortController()
  const outcome = startBackgroundService(spec, stop.signal).then(value => ({ value }), (error: unknown) => ({ error }))
  await expect.poll(async () => { try { return await readFile(observed, 'utf8') } catch (_error) { return undefined } }).toBeDefined()
  stop.abort()
  expect(await outcome).toMatchObject({ error: { message: 'Local MCP background startup failed' } })
  const received = JSON.parse(await readFile(observed, 'utf8')) as { pid: number }
  expect(isRunning(received.pid)).toBe(false)
})

it('keeps startup ownership when cancellation arrives with its ready response', { timeout: 20000 }, async () => {
  const { spec, owner } = await setup()
  const stop = new AbortController()
  callbacks.afterStatus = (status) => {
    if (!status.ready) return
    owner.pid = status.pid
    stop.abort()
  }
  await expect(startBackgroundService(spec, stop.signal)).rejects.toThrow('startup failed')
  if (owner.pid === undefined) throw new Error('Expected the ready-response cancellation barrier')
  expect(isRunning(owner.pid)).toBe(false)
})

it.skipIf(process.platform === 'win32')('terminates an ignored-TERM descendant after its direct owner exits', { timeout: 20000 }, async () => {
  const { spec, observed, owner } = await setup(false, false, { descendant: true, ignoreStop: true })
  const stop = new AbortController()
  const outcome = startBackgroundService(spec, stop.signal).then(value => ({ value }), (error: unknown) => ({ error }))
  await expect.poll(async () => {
    try { return await readFile(observed, 'utf8') } catch (_error) { return undefined }
  }, { timeout: 5000 }).toBeDefined()
  const received = JSON.parse(await readFile(observed, 'utf8')) as { pid: number; descendant: number }
  owner.pid = received.pid
  const inspector = createProcessInspector()
  const descendant = inspector.snapshot().tree(received.pid).find(identity => identity.pid === received.descendant)
  if (descendant === undefined) throw new Error('Expected owned descendant before cancellation')
  onTestFinished(() => { if (inspector.isAlive(descendant)) inspector.signalProcess(descendant, 'SIGKILL') })
  stop.abort()
  expect(await outcome).toMatchObject({ error: { message: 'Local MCP background startup failed' } })
  expect(inspector.isAlive(descendant)).toBe(false)
})

function isRunning(pid: number): boolean {
  try { return process.kill(pid, 0) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}
