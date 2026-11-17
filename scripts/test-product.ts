/** Native product acceptance orchestrator. Generated private state is never uploaded to CI. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readProductBuild } from './product-build.ts'
import { assertProductServiceIdle, verifyProductResults, withProductServiceCheck, withProductRunLock } from './product-service.ts'
import { relaunchBuildRuntime } from './mcp-build-runtime.ts'
import { parseArgs } from 'node:util'
import { verifyDesktopRuntime } from './runtime-inventory.ts'

const root = resolve(import.meta.dirname, '..')
async function main(): Promise<void> {
  const {values} = parseArgs({options:{target:{type:'string'}}})
  if (await relaunchBuildRuntime(root)) return
  await mkdir(join(root, '.artifacts/ci'), { recursive: true })
  await withProductRunLock(async () => {
    const output = join(root, '.artifacts/ci/product-results.json')
    const evidence: Record<string, unknown> = { status: 'failed', platform: process.platform, serviceBefore: 'not checked', serviceAfter: 'not checked', cleanup: 'not run' }
    let state: string | undefined
    let reportTarget = 'unresolved'
    try {
      // No competing runner can delete or overwrite the active run's results.
      await rm(output, { force: true })
      const build = await readProductBuild(root,values.target)
      reportTarget = build.target
      evidence.build = build
      await verifyDesktopRuntime(build.runtime)
      let checks = 0
      await withProductServiceCheck(async () => {
        await mkdir(join(root, '.artifacts/product-tests'), { recursive: true })
        if ((await lstat(join(root, '.artifacts/product-tests'))).isSymbolicLink()) throw new Error('Product test state must not be linked')
        state = await mkdtemp(join(root, '.artifacts/product-tests/run-'))
        const data = join(state, 'desktop-data')
        await mkdir(data)
        const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
          'packages/mcp-proxy/modules/runtime/tests/local-profile.product.spec.ts',
          ...(process.platform === 'win32' ? ['packages/mcp-proxy/modules/runtime/tests/native-activation.product.spec.ts'] : []),
          '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', '--outputFile', output], {
          cwd: root, windowsHide: true, shell: false, stdio: 'inherit',
          env: { ...process.env, MCP_PROXY_PRODUCT_TESTS: '1', MCP_PROXY_RUNTIME_DIR: undefined,
            MCP_PROXY_DESKTOP_EXE: build.executable, MCP_PROXY_DESKTOP_RUNTIME: build.runtime, MCP_PROXY_DESKTOP_DATA: data },
        })
        const [code, signal] = await once(child, 'exit') as [number | null, string | null]
        evidence.testExitCode = code; evidence.testSignal = signal
        if (code !== 0 || signal !== null) throw new Error('Native product test process failed; inspect product-results.json')
        const results: unknown = JSON.parse(await readFile(output, 'utf8'))
        verifyProductResults(results,process.platform === 'win32' ? 5 : 3)
        evidence.tests = { passed: process.platform === 'win32' ? 5 : 3, skipped: 0 }
        await copyFile(output,join(root,`.artifacts/ci/product-${reportTarget}-results.json`))
      }, async () => {
        const phase = ++checks === 1 ? 'serviceBefore' : 'serviceAfter'
        evidence[phase] = 'checking'
        try { await assertProductServiceIdle(); evidence[phase] = 'idle' }
        catch (error) { evidence[phase] = 'occupied or unverifiable'; throw error }
      })
      if (state) {
        if (!resolve(state).startsWith(join(root, '.artifacts/product-tests/run-')) || (await lstat(state)).isSymbolicLink()) throw new Error('Product state ownership changed; refusing cleanup')
        await rm(state, { recursive: true, force: true }); evidence.cleanup = 'test-owned data removed'
      }
      evidence.status = 'passed'
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : 'Unknown native acceptance failure'
      if (state) evidence.cleanup = 'private test state retained for diagnosis; not uploaded'
      throw error
    } finally {
      await writeFile(join(root, '.artifacts/ci/product-verification.json'), JSON.stringify(evidence, null, 2) + '\n')
      await writeFile(join(root, `.artifacts/ci/product-${reportTarget}.json`), JSON.stringify(evidence, null, 2) + '\n')
    }
  })
}
void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Native acceptance failed'}\n`); process.exitCode = 1 })
