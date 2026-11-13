import { expect, it, onTestFinished } from 'vitest'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadPrimaryRuntimeAsset } from './download-runtime.ts'

it('publishes complete concurrent downloads and never rewrites an accepted cache file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-runtime-cache-'))
  const bytes = Buffer.alloc(1024 * 1024, 'x')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const server = createServer((_request, response) => { response.end(bytes) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  onTestFinished(async () => { await new Promise<void>(resolve => { server.close(() => resolve()) }); await rm(directory, { recursive: true, force: true }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const url = `http://127.0.0.1:${address.port}/node.zip`
  const files = await Promise.all(Array.from({ length: 4 }, () => downloadPrimaryRuntimeAsset(url, hash, directory)))
  expect(new Set(files).size).toBe(1)
  expect(await readFile(files[0]!)).toEqual(bytes)
  const modified = (await stat(files[0]!)).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 30))
  await downloadPrimaryRuntimeAsset(url, hash, directory)
  expect((await stat(files[0]!)).mtimeMs).toBe(modified)
})
