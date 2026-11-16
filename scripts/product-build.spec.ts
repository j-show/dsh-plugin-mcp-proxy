import { expect, it, onTestFinished } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { writeProductBuild, readProductBuild } from './product-build.ts'
import { assertProductServiceIdle, verifyProductResults, withProductServiceCheck, withProductRunLock } from './product-service.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-product-binding-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, '.artifacts/build-win-64-fixture/distribution')
  const exe = join(root, 'release/mcp-proxy/win-64/mcp-proxy-setup.exe')
  await mkdir(join(runtime, 'resources'), { recursive: true }); await mkdir(dirname(exe), { recursive: true })
  await mkdir(join(dirname(runtime),'installer'))
  await writeFile(exe, 'installer'); await writeFile(join(runtime, 'resources/mcp-runtime.json'), '{}')
  await writeFile(join(runtime, 'mcp-proxy.exe'), 'application')
  await writeFile(join(dirname(runtime),'installer/mcp-proxy-setup.exe'),'installer')
  return { root, runtime, exe }
}
it('binds an explicit successful build and rejects mixed or replaced outputs', async () => {
  const f = await fixture()
  await writeProductBuild(f.root, f.exe, f.runtime)
  expect((await readProductBuild(f.root)).runtime).toBe(f.runtime)
  await writeFile(f.exe, 'other build')
  await expect(readProductBuild(f.root)).rejects.toThrow('hash')
  await writeFile(f.exe, 'installer'); await writeFile(join(f.runtime, 'resources/mcp-runtime.json'), '{"other":1}')
  await expect(readProductBuild(f.root)).rejects.toThrow('hash')
})
it('rejects traversal in build metadata instead of discovering a latest directory', async () => {
  const f = await fixture(); await writeProductBuild(f.root, f.exe, f.runtime)
  const file = join(f.root, 'release/mcp-proxy/product-build.json')
  const receipt = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...receipt, runtime: '../outside' }))
  await expect(readProductBuild(f.root)).rejects.toThrow('path')
})
it('rejects a valid build record copied under a different requested architecture', async () => {
  const f = await fixture(); await writeProductBuild(f.root,f.exe,f.runtime)
  const wrong = join(f.root,'release/mcp-proxy/win-32/product-build.json')
  await mkdir(dirname(wrong),{recursive:true})
  await writeFile(wrong,await readFile(join(f.root,'release/mcp-proxy/win-64/product-build.json')))
  await expect(readProductBuild(f.root,'win-32')).rejects.toThrow('target')
})
it('does not bind a concurrent publication to another build runtime', async () => {
  const f = await fixture()
  const original = join(f.runtime, 'mcp-proxy.exe')
  await writeFile(original, 'this build'); await writeFile(f.exe, 'concurrent build')
  await writeProductBuild(f.root, f.exe, f.runtime, original)
  await expect(readProductBuild(f.root)).rejects.toThrow('hash')
})
it('executes the unique build even if a later publication replaces the shared EXE', async () => {
  const f = await fixture(); await writeProductBuild(f.root, f.exe, f.runtime)
  const bound = await readProductBuild(f.root)
  await writeFile(f.exe, 'a later build')
  expect(bound.executable).toBe(join(f.runtime, 'mcp-proxy.exe'))
  expect(await readFile(bound.executable, 'utf8')).toBe('application')
})
it('refuses an occupied slot and never sends a stop command to its owner', async () => {
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\product-probe-${process.pid}` : join((await fixture()).root, 'probe.sock')
  const received: string[] = []
  const server = createServer(socket => { socket.on('data', bytes => received.push(bytes.toString())) })
  server.listen(address); await once(server, 'listening')
  await expect(assertProductServiceIdle(address)).rejects.toThrow('unused')
  expect(received).toEqual([])
  await new Promise<void>(resolve => server.close(() => resolve()))
  await expect(assertProductServiceIdle(address)).resolves.toBeUndefined()
})
it('checks cleanup even when the test process fails and rejects leaked service ownership', async () => {
  let probes = 0
  await expect(withProductServiceCheck(async () => { throw new Error('tests failed') }, async () => { probes++ }))
    .rejects.toThrow('tests failed')
  expect(probes).toBe(2)
  await expect(withProductServiceCheck(async () => {}, async () => { if (++probes === 4) throw new Error('leaked slot') }))
    .rejects.toThrow('leaked slot')
})
it('requires all five native cases to execute without skips', () => {
  expect(() => verifyProductResults({ success: true, numTotalTests: 5, numPassedTests: 5, numFailedTests: 0, numPendingTests: 0 })).not.toThrow()
  expect(() => verifyProductResults({ success: true, numTotalTests: 5, numPassedTests: 0, numFailedTests: 0, numPendingTests: 5 })).toThrow()
  expect(() => verifyProductResults({ success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0 })).toThrow()
})
it('does not let a competing runner mutate active result files', async () => {
  const f = await fixture()
  const result = join(f.root, 'result.json')
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const first = withProductRunLock(async () => { await writeFile(result, 'active'); entered.resolve(); await released.promise }, join(f.root, 'run-lock'))
  await entered.promise
  try {
    await expect(withProductRunLock(async () => { await rm(result) }, join(f.root, 'run-lock'), 10)).rejects.toThrow()
    expect(await readFile(result, 'utf8')).toBe('active')
  } finally { released.resolve(); await first }
})
