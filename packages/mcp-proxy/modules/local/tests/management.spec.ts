import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { LocalMcpPool, resolveLocalServices } from '../src/index.ts'
import { ProxyToolSchema } from '@j-show/mcp-proxy-protocol'

const options = { maxServices: 4, maxFrameBytes: 65536, maxDiscoveryPages: 8, maxClientRequests: 8,
  maxClientRequestRecords: 32, startupTimeoutMs: 10000, callTimeoutMs: 10000, taskCancelTimeoutMs: 1000 }

it('adds and removes shared MCPs without restarting an unrelated child or reusing an old incarnation', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-management-'))
  const pool = await LocalMcpPool.open([], options)
  onTestFinished(async () => { await pool.close(); await rm(directory, { recursive: true, force: true }) })
  const config = (service: string) => resolveLocalServices([{ service, transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/files.mjs', import.meta.url))] }], directory)[0]!
  await pool.add(config('a'), new AbortController().signal)
  await pool.add(config('b'), new AbortController().signal)
  const before = await pool.catalog()
  const b = await pool.call('b', 'pid', {}, new AbortController().signal)
  const a = before.services.find(s => s.service === 'a')!
  const tool = before.tools.find(entry => entry.service === 'a')!
  expect(pool.matchesTool(tool, a.incarnation)).toBe(true)
  expect(pool.matchesTool(ProxyToolSchema.parse({ ...tool, description: 'changed definition' }), a.incarnation)).toBe(false)
  const resume = pool.pause('a')
  expect(pool.hasIncarnation('a', a.incarnation)).toBe(false)
  await expect(pool.call('a', 'pid', {}, new AbortController().signal)).rejects.toThrow()
  resume()
  expect(pool.hasIncarnation('a', a.incarnation)).toBe(true)
  await pool.remove('a')
  await pool.add(config('a'), new AbortController().signal)
  const after = await pool.catalog()
  expect(after.revision).not.toBe(before.revision)
  expect(after.services.find(s => s.service === 'a')?.incarnation).not.toBe(a.incarnation)
  expect(pool.hasIncarnation('a', a.incarnation)).toBe(false)
  expect(await pool.call('b', 'pid', {}, new AbortController().signal)).toEqual(b)
  const replacement = await pool.call('a', 'pid', {}, new AbortController().signal)
  const bPid = (b.structuredContent as { pid:number }).pid
  const replacementPid = (replacement.structuredContent as { pid:number }).pid
  process.kill(bPid)
  await expect.poll(() => pool.available).toBe(false)
  await pool.remove('a')
  expect(() => process.kill(replacementPid, 0)).toThrow()
  await pool.recoverService('b', new AbortController().signal)
  const recovered = await pool.catalog()
  expect(recovered.services.find(service => service.service === 'b')?.incarnation)
    .not.toBe(before.services.find(service => service.service === 'b')?.incarnation)
  expect((await pool.call('b', 'pid', {}, new AbortController().signal)).structuredContent).not.toEqual(b.structuredContent)
})

it('keeps the committed shared catalog after an invalid MCP addition', async () => {
  const pool = await LocalMcpPool.open([], options)
  onTestFinished(() => pool.close())
  const before = await pool.catalog()
  const config = resolveLocalServices([{ service: 'broken', transport: 'stdio', command: process.execPath,
    args: ['-e', 'process.exit(1)'] }], process.cwd())[0]!
  await expect(pool.add(config, new AbortController().signal)).rejects.toThrow()
  expect(await pool.catalog()).toEqual(before)
})
