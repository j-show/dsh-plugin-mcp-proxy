/** Required cold-process observations against independently installed public DSH profiles. */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserCdp, eventually, prepareDshPage, safeBrowserDiagnostic } from './browser-cdp.ts'
import { coldBootsPerEnvironment, coldEnvironments, ownedCertificate } from './browser-e2e-contract.ts'
import { nativeProbe } from './browser-native.ts'
import { isolatedEnvironment, startBrowserWeb, type ServerArtifact } from './browser-e2e-environment.ts'

interface Identity { pid: number; started: string }
interface Boot { index: number; profile: string; version: string; cdpMs: number; webMs: number; cleanup: boolean }
export interface ColdStartup { browser: string; environments: Array<{ index: number; pluginSha256: string; boots: Boot[]; cleanup: boolean }> }

async function coldBoot(repository: string, directory: string, helper: string, executable: string, bootstrap: string, origin: string,
  index: number, reportName: string): Promise<Boot> {
  const profileName = `profile-${index}`, profile = join(directory, profileName)
  const home = join(directory, `home-${index}`), data = join(home, 'local'), roaming = join(home, 'roaming'), temp = join(home, 'temp')
  for (const path of [profile, data, roaming, temp]) await mkdir(path, { recursive: true })
  let child: ChildProcess | undefined, identity: Identity | undefined, cdp: BrowserCdp | undefined
  let output = '', stage = 'process spawn'
  const owned = new Map<number, Identity>()
  const started = Date.now()
  const stopped = (id: Identity) => eventually(async () => !await nativeProbe<boolean>(helper, 'alive', String(id.pid), id.started), 'cold browser exit')
  try {
    child = spawn(executable, ['--user-data-dir=' + profile, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      '--disable-background-mode', '--force-renderer-accessibility', '--window-size=1200,800', 'about:blank'],
    { env: { ...isolatedEnvironment(home, data), APPDATA: roaming, TEMP: temp, TMP: temp }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
    child.stdout?.on('data', bytes => { output = (output + String(bytes)).slice(-65536) })
    child.stderr?.on('data', bytes => { output = (output + String(bytes)).slice(-65536) })
    await once(child, 'spawn')
    identity = await nativeProbe<Identity>(helper, 'identity', String(child.pid))
    if (!identity) throw new Error('Cold browser process identity unavailable')
    owned.set(identity.pid, identity)
    stage = 'debugging endpoint'
    cdp = await BrowserCdp.page(profile, origin, () => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`Browser exited before CDP: code=${child!.exitCode}; signal=${child!.signalCode}`)
    })
    const cdpMs = Date.now() - started
    for (const id of await nativeProbe<Identity[]>(helper, 'children', String(identity.pid), identity.started)) owned.set(id.pid, id)
    const version = await cdp.send('Browser.getVersion') as { product: string }
    const window = await cdp.send('Browser.getWindowForTarget') as { windowId: number; bounds: { windowState: string } }
    await writeFile(join(repository, `.artifacts/ci/${reportName}-window.json`), JSON.stringify(window, null, 2))
    stage = 'browser foreground'
    await cdp.send('Page.navigate', { url: bootstrap })
    await cdp.send('Page.bringToFront')
    await nativeProbe(helper, 'focus-browser', String(identity.pid), identity.started)
    await eventually(() => cdp!.evaluate<boolean>('document.visibilityState === "visible" && document.hasFocus()'), 'visible foreground browser page')
    stage = 'new-profile Web activation'
    await prepareDshPage(cdp, 'settings')
    await cdp.clickText('^(This computer|本机连接)$')
    await eventually(() => cdp!.evaluate<boolean>('!!document.querySelector("[data-mcp-phase]")'), 'activated MCP settings')
    const webMs = Date.now() - started - cdpMs
    stage = 'browser close'
    const children = await nativeProbe<Identity[]>(helper, 'children', String(identity.pid), identity.started)
    for (const id of children) owned.set(id.pid, id)
    await nativeProbe(helper, 'close-browser', String(identity.pid), identity.started)
    for (const id of [identity, ...children]) await stopped(id)
    return { index, profile: `${reportName}/${profileName}`, version: version.product, cdpMs, webMs, cleanup: true }
  } catch (error) {
    if (cdp) {
      try {
        const page = await cdp.evaluate<{ query: string; text: string; focused: boolean; visibility: string }>('({query:location.search,text:document.body?.innerText??"",focused:document.hasFocus(),visibility:document.visibilityState})')
        await writeFile(join(repository, `.artifacts/ci/${reportName}-page.json`), JSON.stringify({ stage, text: safeBrowserDiagnostic(page.text), focused: page.focused, visibility: page.visibility }, null, 2))
        if (!page.query && !/mcp-proxy:\/\/associate\/|BEGIN .*PRIVATE KEY|[A-Za-z0-9_-]{43,}|password|api[_ -]?key|\bcookie\b|\btoken\b/i.test(page.text)) {
          const image = await cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string }
          await writeFile(join(repository, `.artifacts/ci/${reportName}-failure.png`), Buffer.from(image.data, 'base64'))
        }
      } catch { /* Preserve the primary failure when a crashed page cannot be read. */ }
    }
    await writeFile(join(repository, `.artifacts/ci/${reportName}-failure.json`), JSON.stringify({ stage,
      error: safeBrowserDiagnostic(error instanceof Error ? error.message : 'unknown failure'),
      exitCode: child?.exitCode, signal: child?.signalCode, output: safeBrowserDiagnostic(output),
      messages: cdp?.diagnostics(), modules: cdp?.moduleRevisions() }, null, 2))
    throw new Error(`${reportName} ${stage}: ${error instanceof Error ? error.message : 'unknown failure'}`)
  } finally {
    cdp?.close()
    // Never enumerate another profile's processes or use an unfenced PID.
    if (identity && await nativeProbe<boolean>(helper, 'alive', String(identity.pid), identity.started)) {
      for (const id of await nativeProbe<Identity[]>(helper, 'children', String(identity.pid), identity.started)) owned.set(id.pid, id)
    }
    for (const id of [...owned.values()].reverse()) {
      if (await nativeProbe<boolean>(helper, 'alive', String(id.pid), id.started)) {
        await nativeProbe(helper, 'kill-owned', String(id.pid), id.started); await stopped(id)
      }
    }
    if (child && !identity && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }
  }
}

export async function runColdStartup(repository: string, state: string, helper: string, browser: string, executable: string, artifact: ServerArtifact): Promise<ColdStartup> {
  const result: ColdStartup = { browser, environments: [] }
  for (let index = 0; index < coldEnvironments; index++) {
    const directory = await mkdtemp(join(state, `${browser}-cold-${index}-`))
    const name = `browser-${browser}-cold-${index}`
    let web: Awaited<ReturnType<typeof startBrowserWeb>> | undefined, certificate: { thumbprint: string; added: boolean } | undefined
    const observation = { index, pluginSha256: artifact.sha256, boots: [] as Boot[], cleanup: false }
    result.environments.push(observation)
    let failure: unknown
    try {
      web = await startBrowserWeb(repository, directory, artifact)
      await writeFile(join(repository, `.artifacts/ci/${name}-framework.json`), JSON.stringify(web.frameworks, null, 2))
      certificate = await nativeProbe(helper, 'ca-add', web.caFile)
      for (let boot = 0; boot < coldBootsPerEnvironment; boot++) {
        observation.boots.push(await coldBoot(repository, directory, helper, executable, web.bootstrap, web.origin, boot, `${name}-${boot}`))
      }
    } catch (error) { failure = error }
    const cleanupErrors: string[] = []
    try { if (web) await web.stop() } catch { cleanupErrors.push('DSH shutdown') }
    try {
      if (certificate && ownedCertificate(certificate.thumbprint, certificate)) await nativeProbe(helper, 'ca-remove', certificate.thumbprint)
    } catch { cleanupErrors.push('CA removal') }
    if (!failure && !cleanupErrors.length) {
      try { await rm(directory, { recursive: true, force: true }); observation.cleanup = true }
      catch { cleanupErrors.push('private state removal') }
    }
    await writeFile(join(repository, `.artifacts/ci/${name}-requests.json`), JSON.stringify(web?.diagnostics() ?? []))
    await writeFile(join(repository, `.artifacts/ci/browser-${browser}-cold.json`), JSON.stringify({ ...result, cleanupErrors }, null, 2))
    if (failure || cleanupErrors.length) throw new Error(`${failure instanceof Error ? failure.message : 'Cold environment cleanup failed'}${cleanupErrors.length ? '; cleanup: ' + cleanupErrors.join(', ') : ''}`)
  }
  return result
}
