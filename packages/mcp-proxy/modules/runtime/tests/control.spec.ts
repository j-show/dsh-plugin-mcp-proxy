import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { associationFromUri, forwardLocalAssociation, listenLocalControl, requestLocalStop, requestLocalStatus, requestLocalManagement } from '../src/control.ts'

async function address() {
  const root = await mkdtemp(join(tmpdir(), 'proxy-control-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return process.platform === 'win32' ? `\\\\.\\pipe\\proxy-control-test-${randomUUID()}` : join(root, 'control.sock')
}

it('uses bounded management JSON on the private owner without interpreting it as URI or stop', async () => {
  const path = await address()
  const received: unknown[] = []
  const server = await listenLocalControl(path, { maxConnections: 4, timeoutMs: 2000 }, async () => {
    throw new Error('Management must not invoke the URI handler')
  }, undefined, undefined, { maxRequestBytes: 1024, maxResponseBytes: 2048, handle: async request => {
    received.push(request)
    return { servers: [{ origin: 'https://a.example', state: 'connected' }] }
  } })
  onTestFinished(() => server.close())
  expect(await requestLocalManagement(path, { kind: 'snapshot' }, 2000, 2048))
    .toEqual({ servers: [{ origin: 'https://a.example', state: 'connected' }] })
  expect(received).toEqual([{ kind: 'snapshot' }])
  await expect(requestLocalManagement(path, { kind: 'invalid', text: 'x'.repeat(2048) }, 2000, 2048)).rejects.toThrow()
  expect(received).toHaveLength(1)
})

it('forwards one local transaction and prevents a second listener from taking the same address', async () => {
  const path = await address()
  const received: string[] = []
  const server = await listenLocalControl(path, { maxConnections: 4, timeoutMs: 2000 }, async (id) => { received.push(id) })
  onTestFinished(async () => { await server.close() })
  const id = 'a'.repeat(43)
  await forwardLocalAssociation(path, id, 2000)
  expect(received).toEqual([id])
  await expect(listenLocalControl(path, { maxConnections: 4, timeoutMs: 2000 }, async () => {})).rejects.toThrow()
})

it('accepts only a transaction URI without server, credential or execution fields', () => {
  const id = 'a'.repeat(43)
  expect(associationFromUri(`mcp-proxy://associate/${id}`)).toBe(id)
  for (const uri of [`https://associate/${id}`, `mcp-proxy://other/${id}`, `mcp-proxy://associate/${id}?server=https://other`,
    `mcp-proxy://credential@associate/${id}`, `mcp-proxy://associate/${id}#run`, 'mcp-proxy://associate/short']) {
    expect(() => associationFromUri(uri)).toThrow('Invalid mcp-proxy association URI')
  }
})

it('rejects an oversized control frame without forwarding it', async () => {
  const path = await address()
  let forwarded = false
  const server = await listenLocalControl(path, { maxConnections: 4, timeoutMs: 2000 }, async () => { forwarded = true })
  onTestFinished(async () => { await server.close() })
  const socket = createConnection(path)
  onTestFinished(() => { socket.destroy() })
  await once(socket, 'connect')
  socket.write('a'.repeat(44) + '\n')
  const chunks: Buffer[] = []
  for await (const chunk of socket) chunks.push(chunk as Buffer)
  expect(Buffer.concat(chunks).toString()).toBe('ERROR\n')
  expect(forwarded).toBe(false)
})

it('bounds pending forwarding and waits for its owner before closing', async () => {
  const path = await address()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const server = await listenLocalControl(path, { maxConnections: 1, timeoutMs: 2000 }, async () => {
    entered.resolve(undefined)
    await release.promise
  })
  onTestFinished(async () => { release.resolve(undefined); await server.close() })
  const pending = forwardLocalAssociation(path, 'a'.repeat(43), 2000).then(() => 'ok', () => 'failed')
  await entered.promise
  await expect(forwardLocalAssociation(path, 'b'.repeat(43), 2000)).rejects.toThrow('unavailable')
  let closed = false
  const closing = server.close().then(() => { closed = true })
  expect(await pending).toBe('failed')
  expect(closed).toBe(false)
  release.resolve(undefined)
  await closing
  expect(closed).toBe(true)
})

it('acknowledges an explicit local stop without forwarding a browser transaction', async () => {
  const path = await address()
  let stopped = false
  let forwarded = false
  const server = await listenLocalControl(path, { maxConnections: 2, timeoutMs: 2000 },
    async () => { forwarded = true }, () => { stopped = true })
  onTestFinished(async () => { await server.close() })
  await requestLocalStop(path, 2000)
  await expect.poll(() => stopped).toBe(true)
  expect(forwarded).toBe(false)
})

it('reports the local process and its current acknowledged readiness without forwarding a transaction', async () => {
  const path = await address()
  let ready = false
  const server = await listenLocalControl(path, { maxConnections: 2, timeoutMs: 2000 }, async () => {
    throw new Error('Status cannot forward a browser transaction')
  }, undefined, () => ready)
  onTestFinished(() => server.close())
  expect(await requestLocalStatus(path, 2000)).toEqual({ pid: process.pid, ready: false })
  ready = true
  expect(await requestLocalStatus(path, 2000)).toEqual({ pid: process.pid, ready: true })
})

it('rejects a targeted stop for another process before acknowledging its own owner', async () => {
  const path = await address()
  let stopped = false
  const server = await listenLocalControl(path, { maxConnections: 2, timeoutMs: 2000 }, async () => {}, () => { stopped = true })
  onTestFinished(() => server.close())
  await expect(requestLocalStop(path, 2000, process.pid + 1)).rejects.toThrow('unavailable')
  expect(stopped).toBe(false)
  await requestLocalStop(path, 2000, process.pid)
  await expect.poll(() => stopped).toBe(true)
})

it.skipIf(process.platform === 'win32')('preserves a non-socket file at the Unix control address', async () => {
  const path = await address()
  await writeFile(path, 'keep')
  await expect(listenLocalControl(path, { maxConnections: 2, timeoutMs: 2000 }, async () => {})).rejects.toThrow('socket')
  expect((await lstat(path)).isFile()).toBe(true)
})

it.skipIf(process.platform === 'win32')('recovers an abandoned Unix socket after its process exits', async () => {
  const path = await address()
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/unix-socket.mjs', import.meta.url)), path],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  onTestFinished(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Fixture exited before binding') })])
  child.kill('SIGKILL')
  await exited
  expect((await lstat(path)).isSocket()).toBe(true)
  const received: string[] = []
  const server = await listenLocalControl(path, { maxConnections: 2, timeoutMs: 2000 }, async (id) => { received.push(id) })
  onTestFinished(() => server.close())
  await forwardLocalAssociation(path, 'a'.repeat(43), 2000)
  expect(received).toEqual(['a'.repeat(43)])
})
