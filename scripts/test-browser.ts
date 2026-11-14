/** Chrome/Edge real-desktop acceptance. Unknown URI owners and missing desktops fail closed. */
import { access, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { compileDesktopProbe, nativeProbe } from './browser-native.ts'
import { assertDesktopPreflight, assertStartupPreflight, requireColdStartupMatrix, requireBrowserMatrix, type DesktopPreflight } from './browser-e2e-contract.ts'
import { runColdStartup, type ColdStartup } from './browser-startup.ts'
import { runBrowserMatrix } from './browser-e2e-run.ts'
import { bindServerArtifact } from './browser-e2e-environment.ts'
import { readProductBuild } from './product-build.ts'
import { assertProductServiceIdle, withProductRunLock } from './product-service.ts'
import { prepareMcpBuildRuntime, mcpBuildEnvironment } from './mcp-build-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'

const root = resolve(import.meta.dirname, '..')
const { values, positionals } = parseArgs({ options: { preflight: { type: 'boolean' }, 'startup-only': { type: 'boolean' } } })
if (positionals.length) throw new Error('Unexpected browser test arguments')
if (values.preflight && values['startup-only']) throw new Error('Choose preflight or startup-only')
async function installed(candidates: string[]): Promise<string | undefined> {
  for (const file of candidates) try { await access(file); return file } catch { /* Try only known public browser installation locations. */ }
}
async function main(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Browser E2E requires Windows x64')
  const node = await prepareMcpBuildRuntime(root)
  if (node) { await runMcpBuildCommand(node, ['--import', 'tsx/esm', ...process.argv.slice(1)], root, mcpBuildEnvironment(node, process.env)); return }
  for (const path of ['.artifacts', '.artifacts/ci', '.artifacts/browser-e2e']) {
    await mkdir(join(root, path), { recursive: true })
    if ((await lstat(join(root, path))).isSymbolicLink()) throw new Error('Browser test parent must not be linked')
  }
  await withProductRunLock(async () => {
    const evidence: Record<string, unknown> = { status: 'failed', browsers: [], preflightOnly: !!values.preflight,
      scope: values['startup-only'] ? 'cold Chrome/Edge and fresh DSH environments; no URI or desktop product actions'
        : 'real headed Chrome/Edge and native Windows desktop; not a model test' }
    await mkdir(join(root, '.artifacts/browser-e2e'), { recursive: true })
    if ((await lstat(join(root, '.artifacts/browser-e2e'))).isSymbolicLink()) throw new Error('Browser test state must not be linked')
    const state = await mkdtemp(join(root, '.artifacts/browser-e2e/run-'))
    try {
      const helper = await compileDesktopProbe(state)
      await nativeProbe(helper, 'protect-state', state)
      const chrome = await installed([join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe')])
      const edge = await installed([join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'), join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe')])
      const preflight = { ...await nativeProbe<Omit<DesktopPreflight, 'chrome' | 'edge'>>(helper, 'preflight'), chrome: !!chrome, edge: !!edge }
      evidence.preflight = preflight
      await writeFile(join(root, '.artifacts/ci/browser-preflight.json'), JSON.stringify(preflight, null, 2))
      if (values['startup-only']) assertStartupPreflight(preflight)
      else { assertDesktopPreflight(preflight); await assertProductServiceIdle() }
      if (!values.preflight) {
        const serverArtifact = await bindServerArtifact(root, state)
        evidence.serverArtifact = { sha256: serverArtifact.sha256 }
        const cold: ColdStartup[] = []
        evidence.coldStartup = cold
        for (const [browser, executable] of [['chrome', chrome!], ['edge', edge!]] as const) {
          evidence.stage = `${browser} cold startup`
          cold.push(await runColdStartup(root, state, helper, browser, executable, serverArtifact))
        }
        requireColdStartupMatrix(cold)
        if (!values['startup-only']) {
          const build = await readProductBuild(root)
          evidence.build = build
          const qualification = await import(pathToFileURL(join(root, 'packages/mcp-proxy/src/runtime-cache.ts')).href) as { verifyElectronRuntime(root: string): Promise<void> }
          await qualification.verifyElectronRuntime(build.runtime)
          const browsers = []
          for (const [browser, executable] of [['chrome', chrome!], ['edge', edge!]] as const) {
            evidence.stage = browser
            browsers.push(await runBrowserMatrix(root, state, helper, build.executable, browser, executable, serverArtifact))
            evidence.browsers = browsers
          }
          requireBrowserMatrix(browsers)
          await assertProductServiceIdle()
        }
      }
      if (!resolve(state).startsWith(join(root, '.artifacts/browser-e2e/run-')) || (await lstat(state)).isSymbolicLink()) throw new Error('Browser state ownership changed; refusing removal')
      await rm(state, { recursive: true, force: true })
      evidence.cleanup = values.preflight ? 'preflight private state removed; no URI/CA/browser changes performed'
        : values['startup-only'] ? 'cold Web/browser private state and owned CAs removed; URI and desktop service untouched'
          : 'owned private state removed; URI/CA/process/service checks passed'
      evidence.status = 'passed'
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : 'Unknown browser E2E failure'
      evidence.cleanup = 'private diagnostics retained; never uploaded'
      throw error
    } finally {
      await writeFile(join(root, '.artifacts/ci/browser-verification.json'), JSON.stringify(evidence, null, 2) + '\n')
    }
  })
}
void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Browser E2E failed'}\n`); process.exitCode = 1 })
