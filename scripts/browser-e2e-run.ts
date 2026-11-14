/** Real browser/OS/desktop actions. No tray-event injection or direct association mutation. */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserCdp, eventually, prepareDshPage, verifyPageBoots, safeBrowserDiagnostic } from './browser-cdp.ts'
import { nativeProbe, nativeActionSession, confirmNativeAction, confirmNativeProtocol, type NativeWindow } from './browser-native.ts'
import { uniqueTarget, ownedCertificate, activeMcpIdentities, type DesktopPreflight } from './browser-e2e-contract.ts'
import { startBrowserWeb, isolatedEnvironment, alive, type WebFixture, type ServerArtifact } from './browser-e2e-environment.ts'
import { assertProductServiceIdle } from './product-service.ts'

interface Identity { pid: number; started: string }
interface ControlApi {
  machineControlAddress(): Promise<string>
  requestLocalStatus(address: string, timeout: number): Promise<{ pid: number; ready: boolean }>
  requestLocalManagement(address: string, request: unknown, timeout: number, limit: number): Promise<{ ok: boolean; snapshot?: { pid: number; settingsFile: string; servers: Array<{ state: string }> } }>
  requestLocalStop(address: string, timeout: number, pid: number): Promise<void>
}
export async function runBrowserMatrix(repository: string, state: string, helper: string, executable: string,
  browser: 'chrome' | 'edge', browserExecutable: string, serverArtifact: ServerArtifact): Promise<{ browser: string; scenarios: Record<string, boolean>; guards: { webDocumentRejected: boolean; documentDepth: number; ancestorLimit: number; trayOcclusionRefused: boolean }; pluginSha256: string; version: string }> {
  const scope = join(state, browser)
  const data = join(scope, 'app-data'), home = join(scope, 'client-home'), workspace = join(scope, 'workspace'), profile = join(scope, 'browser-profile')
  const temp = join(scope, 'temp')
  for (const dir of [scope, data, home, workspace, profile, temp]) await mkdir(dir, { recursive: true })
  const settings = join(scope, 'settings.json'), marker = join(scope, 'mcp-pids.jsonl')
  const scenarios: Record<string, boolean> = {}
  const control = await import(pathToFileURL(join(repository, 'packages/mcp-proxy/modules/runtime/src/control.ts')).href) as ControlApi
  const address = await control.machineControlAddress()
  const env = { ...isolatedEnvironment(home, data), TEMP: temp, TMP: temp }
  let web: WebFixture | undefined, certificate: { thumbprint: string; added: boolean } | undefined
  let gui: NativeWindow | undefined, browserProcess: ChildProcess | undefined, browserIdentity: Identity | undefined, cdp: BrowserCdp | undefined
  let service: { pid: number; ready: boolean } | undefined
  let launcher: ChildProcess | undefined
  let browserOutput = ''
  let failure: unknown
  let stage = 'web-install'
  const observed = new Map<number, Identity>()
  const remember = async (id: number) => { const identity = await nativeProbe<Identity | null>(helper, 'identity', String(id)); if (!identity) throw new Error('Required owned process identity unavailable'); observed.set(id, identity); return identity }
  const stopped = (identity: Identity) => eventually(async () => !await nativeProbe<boolean>(helper, 'alive', String(identity.pid), identity.started), 'owned process exit', 30000)
  const nativeActions = nativeActionSession((operation, ...args) => nativeProbe(helper, operation, ...args))
  const action = async (operation: string, target: Identity, ...args: string[]) => nativeActions.action(operation, String(target.pid), target.started, ...args)
  const status = async () => {
    const reply = await control.requestLocalManagement(address, { kind: 'snapshot' }, 3000, 1048576)
    if (!reply.ok || resolve(reply.snapshot?.settingsFile ?? '').toLowerCase() !== resolve(settings).toLowerCase()) throw new Error('Machine service belongs to another configuration')
    return reply.snapshot!
  }
  const guiState = async () => {
    const rows = await nativeProbe<NativeWindow[]>(helper, 'gui', data)
    return rows.length ? uniqueTarget(rows) : undefined
  }
  const mcpPids = async () => (await readFile(marker, 'utf8')).trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { pid: number }).pid)
  const liveMcps = async () => {
    const tree = await nativeProbe<Identity[]>(helper, 'children', String(service!.pid), observed.get(service!.pid)!.started)
    const live = activeMcpIdentities(await mcpPids(), tree, alive)
    for (const identity of live) observed.set(identity.pid, identity)
    return live.map(row => row.pid).sort((a, b) => a - b)
  }
  const uninstall = async () => {
    const installer = await import(pathToFileURL(join(repository, 'packages/mcp-proxy/modules/runtime/src/windows-install.ts')).href) as { uninstallWindowsUri(spec: unknown, timeout: number, signal: AbortSignal): Promise<void> }
    await installer.uninstallWindowsUri({ profileDir: join(home, 'profiles/mcp-proxy'), home, profile: 'mcp-proxy', node: process.execPath,
      cli: join(repository, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), settings, registryKey: 'Software\\Classes\\mcp-proxy', localAppData: data }, 10000, new AbortController().signal)
  }
  try {
    web = await startBrowserWeb(repository, scope, serverArtifact)
    await writeFile(join(repository, `.artifacts/ci/browser-${browser}-framework.json`), JSON.stringify(web.frameworks, null, 2))
    stage = 'CA trust'
    certificate = await nativeProbe(helper, 'ca-add', web.caFile)
    await writeFile(settings, JSON.stringify({ version: 2, directory: workspace, identityFile: join(scope, 'identity.yaml'),
      servers: [{ id: 'e2e', origin: web.origin, enabled: false, mode: 'device', identityRef: 'MCP_E2E_DEVICE', caFile: web.caFile }],
      services: [{ service: 'files', transport: 'stdio', command: process.execPath,
        args: [join(repository, 'packages/mcp-proxy/modules/local/tests/fixtures/files.mjs')], cwd: workspace, roots: [workspace], env: { MCP_FIXTURE_START_MARKER: marker } }] }, null, 2))
    stage = 'GUI startup'
    launcher = spawn(executable, ['--config', settings], { cwd: workspace, env, stdio: 'ignore', windowsHide: true })
    await once(launcher, 'spawn')
    gui = await eventually(guiState, 'product GUI', 180000)
    observed.set(gui.pid, gui)
    service = await eventually(async () => {
      try { const current = await control.requestLocalStatus(address, 1000); return current.ready ? current : false } catch { return false }
    }, 'GUI-owned runtime', 90000)
    stage = 'service identity'
    await status(); await remember(service.pid)
    stage = 'MCP identities'
    await liveMcps()
    const installed = await readFile(join(home, 'profiles/mcp-proxy/mcp-proxy-os/launcher.json'), 'utf8')
    const receipt = JSON.parse(installed) as { owner: string; currentHelper: string; localAppData?: string }
    if (receipt.owner !== createHash('sha256').update(resolve(home, 'profiles/mcp-proxy').toLowerCase()).digest('hex') || receipt.localAppData !== data) throw new Error('URI registration did not retain the test installation context')
    stage = 'browser startup'
    browserProcess = spawn(browserExecutable, ['--user-data-dir=' + profile, '--remote-debugging-port=0', '--no-first-run',
      '--no-default-browser-check', '--disable-background-mode', '--force-renderer-accessibility', '--window-size=1200,800', 'about:blank'], { env, stdio: ['ignore','pipe','pipe'], windowsHide: false })
    browserProcess.stdout?.on('data', bytes => { browserOutput = (browserOutput + String(bytes)).slice(-65536) })
    browserProcess.stderr?.on('data', bytes => { browserOutput = (browserOutput + String(bytes)).slice(-65536) })
    await once(browserProcess, 'spawn')
    browserIdentity = await remember(browserProcess.pid!)
    cdp = await BrowserCdp.page(profile, web.origin, () => {
      if (browserProcess!.exitCode !== null || browserProcess!.signalCode !== null) throw new Error(`Browser exited before CDP: code=${browserProcess!.exitCode}; signal=${browserProcess!.signalCode}`)
    })
    const version = await cdp.send('Browser.getVersion') as { product: string; userAgent: string }
    await cdp.send('Page.bringToFront')
    await eventually(() => cdp!.evaluate<boolean>('document.readyState === "complete" && !!document.body'), 'owned blank document')
    stage = 'protocol webpage rejection guard'
    // Negative fixture lives only on this owned blank tab. It must never be
    // mistaken for native consent, even beyond the bounded ancestor walk.
    await cdp.evaluate(`(() => {
      if(location.href!=='about:blank')throw new Error('Owned blank fixture required');
      const root=document.createElement('div');let node=root;
      for(let i=0;i<50;i++){const group=document.createElement('div');group.setAttribute('role','group');group.setAttribute('aria-label','Protocol guard '+i);node.append(group);node=group;}
      const text=document.createElement('p');text.textContent='mcp-proxy '+${JSON.stringify(web.origin)};node.append(text);
      for(const label of ['Open mcp-proxy','Cancel']){const button=document.createElement('button');button.textContent=label;node.append(button);}
      document.body.replaceChildren(root);
    })()`)
    await eventually(async () => {
      const rows = await nativeProbe<Array<{ buttons: Array<{ kind: string; offscreen: boolean }> }>>(helper, 'gui-dialog-info', String(browserIdentity!.pid), browserIdentity!.started)
      return rows.some(row => row.buttons.some(button => button.kind === 'protocol-open' && !button.offscreen))
    }, 'accessible protocol rejection fixture')
    const documentGuard = await nativeProbe<{ rejected: boolean; documentDepth: number; ancestorLimit: number }>(helper, 'protocol-document-guard', String(browserIdentity.pid), browserIdentity.started, web.origin)
    if (documentGuard.rejected !== true || !Number.isSafeInteger(documentGuard.ancestorLimit) || documentGuard.ancestorLimit < 1
      || documentGuard.documentDepth <= documentGuard.ancestorLimit) throw new Error('Webpage consent rejection guard did not execute')
    await cdp.send('Page.navigate', { url: web.bootstrap })
    await cdp.send('Page.bringToFront')
    await eventually(() => cdp!.evaluate<boolean>('document.readyState === "complete"'), 'DSH document')
    stage = 'settings navigation'
    await verifyPageBoots(20, async index => {
      stage = 'Web startup observation ' + (index + 1)
      if (index > 0) {
        const previous = await cdp!.evaluate<number>('performance.timeOrigin')
        const navigation = await cdp!.send('Page.navigate', { url: web!.origin }) as { loaderId?: string; errorText?: string }
        if (navigation.errorText || !navigation.loaderId) throw new Error('Web document navigation failed')
        await eventually(async () => {
          const frame = await cdp!.send('Page.getFrameTree') as { frameTree: { frame: { loaderId: string } } }
          return frame.frameTree.frame.loaderId === navigation.loaderId
        }, 'matching Web navigation loader')
        await eventually(() => cdp!.evaluate<boolean>(`performance.timeOrigin !== ${previous} && document.readyState === 'complete'`), 'new Web document')
      }
      await prepareDshPage(cdp!)
    })
    await prepareDshPage(cdp, 'settings')
    await cdp.clickText('^(This computer|本机连接)$')
    const connect = async () => {
      await cdp!.send('Page.bringToFront')
      await cdp!.clickText('^(Connect this computer|Reconnect this computer|连接这台电脑|重新连接这台电脑)$')
      await confirmNativeProtocol(() => action('confirm-protocol', browserIdentity!, web!.origin))
      await eventually(async () => { try { return !await nativeProbe<boolean>(helper, 'protocol-prompt', String(browserIdentity!.pid), browserIdentity!.started, web!.origin) } catch { return false } }, 'protocol confirmation closes')
      const trace = join(home, 'profiles/mcp-proxy/mcp-proxy-os', basename(receipt.currentHelper, '.exe') + '.activation.log')
      await eventually(async () => { try { return (await readFile(trace, 'utf8')).trim().length > 0 } catch { return false } }, 'native OS handler execution')
      await eventually(async () => (await status()).servers.some(row => row.state === 'connected'), 'automatic TLS pairing')
      await eventually(() => cdp!.evaluate<boolean>('!!document.querySelector("[data-mcp-phase=connected]")'), 'connected Web presentation')
      const current = await eventually(guiState, 'single URI-activated GUI')
      if (current.pid !== gui!.pid) throw new Error('URI created another GUI instead of using the original instance')
      if (!(await readFile(trace, 'utf8')).includes('activation-forwarded')) throw new Error('No real URI handler forwarding evidence')
      await eventually(async () => {
        const text = await nativeProbe<{ originVisible: boolean; serviceVisible: boolean; connectedVisible: boolean }>(helper, 'gui-connected', String(gui!.pid), gui!.started, web!.origin)
        return text.originVisible && text.connectedVisible
      }, 'connected GUI presentation')
      await action('show-mcps', gui!)
      await eventually(async () => (await nativeProbe<{ serviceVisible: boolean }>(helper, 'gui-connected', String(gui!.pid), gui!.started, web!.origin)).serviceVisible, 'GUI MCP page')
      await action('show-connections', gui!)
    }
    stage = 'initial pairing'
    await connect(); scenarios.pair = true
    await nativeProbe(helper, 'screenshot', String(gui.pid), gui.started, join(repository, `.artifacts/ci/browser-${browser}.png`))
    stage = 'close hides GUI'
    await action('close-window', gui)
    await eventually(async () => { const current = await guiState(); return current && !current.visible ? current : false }, 'close hides GUI')
    if ((await control.requestLocalStatus(address, 1000)).pid !== service.pid) throw new Error('Window close stopped/replaced the service')
    scenarios.hide = true
    stage = 'tray restore'
    const guard = await nativeProbe<{ occlusionRefused: boolean }>(helper, 'tray-hit-guard', String(gui.pid), gui.started)
    if (guard.occlusionRefused !== true) throw new Error('Native notification occlusion guard did not execute')
    await action('tray-click', gui)
    await eventually(async () => { const current = await guiState(); return current?.visible ? current : false }, 'real tray restores GUI')
    scenarios.trayRestore = true
    stage = 'second launch'
    const beforeSecond = await liveMcps()
    const markerCount = (await mcpPids()).length
    const second = spawn(executable, ['--config', settings], { cwd: workspace, env, stdio: 'ignore', windowsHide: true })
    let secondTimeout: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([once(second, 'exit'), new Promise((_, reject) => { secondTimeout = setTimeout(() => reject(new Error('Second launch did not exit')), 180000) })]) }
    finally { clearTimeout(secondTimeout) }
    if ((await guiState())?.pid !== gui.pid || (await status()).pid !== service.pid || JSON.stringify(await liveMcps()) !== JSON.stringify(beforeSecond) || (await mcpPids()).length !== markerCount) throw new Error('Second launch duplicated owned processes')
    scenarios.secondLaunch = true
    stage = 'disconnect and reconnect'
    await action('disconnect', gui)
    await confirmNativeAction('confirm-disconnect', () => action('confirm-disconnect', gui!))
    await eventually(async () => (await status()).servers.every(row => row.state === 'disconnected'), 'GUI disconnect')
    await connect(); scenarios.reconnect = true
    await liveMcps()
    for (const identity of await nativeProbe<Identity[]>(helper, 'children', String(service.pid), (await remember(service.pid)).started)) observed.set(identity.pid, identity)
    for (const identity of await nativeProbe<Identity[]>(helper, 'children', String(gui.pid), gui.started)) observed.set(identity.pid, identity)
    stage = 'tray exit'
    await action('tray-exit', gui)
    for (const identity of observed.values()) if (identity.pid !== browserIdentity.pid) await stopped(identity)
    await assertProductServiceIdle()
    if (await nativeProbe<boolean>(helper, 'tray-present')) throw new Error('Tray icon remained after exit')
    scenarios.trayExit = true
    stage = 'cleanup'
    const browserChildren = await nativeProbe<Identity[]>(helper, 'children', String(browserIdentity.pid), browserIdentity.started)
    await action('close-browser', browserIdentity); for (const identity of browserChildren) await stopped(identity)
    cdp.close(); cdp = undefined
    const pluginSha256 = web.pluginSha256
    await web.stop(); web = undefined
    await uninstall()
    if ((await nativeProbe<Partial<DesktopPreflight>>(helper, 'preflight')).uriOccupied) throw new Error('Test URI registration remains')
    if (!ownedCertificate(certificate!.thumbprint, certificate!)) throw new Error('CA ownership changed')
    await nativeProbe(helper, 'ca-remove', certificate!.thumbprint); certificate = undefined
    scenarios.cleanup = true
    return { browser, scenarios, guards: { webDocumentRejected: true, documentDepth: documentGuard.documentDepth,
      ancestorLimit: documentGuard.ancestorLimit, trayOcclusionRefused: guard.occlusionRefused }, pluginSha256, version: version.product + ' / ' + version.userAgent }
  } catch (error) { failure = error; throw new Error(`${browser} ${stage}: ${error instanceof Error ? error.message : 'unknown failure'}`) }
  finally {
    const errors: string[] = []
    const cleanup = async (label: string, work: () => Promise<unknown>) => { try { await work() } catch { errors.push(label) } }
    if (failure) {
      await cleanup('browser launch diagnostics', () => writeFile(join(repository, `.artifacts/ci/browser-${browser}-launch.json`), JSON.stringify({
        stage, exitCode: browserProcess?.exitCode, signal: browserProcess?.signalCode, output: safeBrowserDiagnostic(browserOutput) }, null, 2)))
      if (gui) {
        try { await writeFile(join(repository, `.artifacts/ci/browser-${browser}-gui.json`), JSON.stringify(await nativeProbe(helper, 'gui-dialog-info', String(gui.pid), gui.started), null, 2)) }
        catch { /* The owned GUI may already have exited; never inspect another application. */ }
      }
      if (browserIdentity) {
        try { await writeFile(join(repository, `.artifacts/ci/browser-${browser}-native.json`), JSON.stringify(await nativeProbe(helper, 'gui-dialog-info', String(browserIdentity.pid), browserIdentity.started), null, 2)) }
        catch { /* The captured browser may have exited; never inspect a different profile. */ }
      }
      try { await writeFile(join(repository, `.artifacts/ci/browser-${browser}-tray.json`), JSON.stringify(await nativeProbe(helper, 'tray-info'), null, 2)) }
      catch { /* Tray diagnostics are structural only and never block owned cleanup. */ }
      try {
        const snapshot = await status()
        let nativeStages: string[] = []
        try {
          const receipt = JSON.parse(await readFile(join(home, 'profiles/mcp-proxy/mcp-proxy-os/launcher.json'), 'utf8')) as { currentHelper: string }
          if (/^mcp-proxy-[a-f0-9]{12}\.exe$/.test(receipt.currentHelper)) {
            nativeStages = (await readFile(join(home, 'profiles/mcp-proxy/mcp-proxy-os', basename(receipt.currentHelper, '.exe') + '.activation.log'), 'utf8'))
              .trim().split('\n').map(line => line.split(' ').at(-1)!).filter(value => /^[a-zA-Z0-9-]+$/.test(value))
          }
        } catch { /* Handler may not have been launched; missing stages are diagnostic evidence. */ }
        await writeFile(join(repository, `.artifacts/ci/browser-${browser}-routing.json`), JSON.stringify({ stage,
          scenarios: { ...scenarios }, servers: snapshot.servers.map(row => ({ state: row.state })), nativeStages, requests: web?.diagnostics() ?? [] }, null, 2))
      } catch { /* Never mask the primary failure when its owned runtime has already exited. */ }
      if (cdp) {
        await cleanup('sanitized client diagnostics', () => writeFile(join(repository, `.artifacts/ci/browser-${browser}-console.json`), JSON.stringify({ messages: cdp!.diagnostics(), modules: cdp!.moduleRevisions() }, null, 2)))
        try {
          const page = await cdp.evaluate<{ query: string; text: string; controls: string[] }>(`({query:location.search,text:document.body.innerText,controls:[...document.querySelectorAll('button,a,[role="tab"],[role="menuitem"]')].map(e=>e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent?.trim()||'').filter(Boolean).slice(0,80)})`)
          const controls = page.controls.map(text => text.replace(/[A-Za-z0-9_-]{43,}/g, '[redacted]'))
          await writeFile(join(repository, `.artifacts/ci/browser-${browser}-controls.json`), JSON.stringify({ stage, controls }, null, 2))
          if (!/token=/i.test(page.query) && !/mcp-proxy:\/\/associate\/|BEGIN .*PRIVATE KEY|[A-Za-z0-9_-]{43,}/.test(page.text)) {
            const image = await cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string }
            await writeFile(join(repository, `.artifacts/ci/browser-${browser}-failure.png`), Buffer.from(image.data, 'base64'))
            if (browserIdentity) {
              try { await nativeProbe(helper, 'screenshot-protocol', String(browserIdentity.pid), browserIdentity.started, web!.origin, join(repository, `.artifacts/ci/browser-${browser}-protocol.png`)) }
              catch { /* The protocol prompt may already have closed; never capture another window. */ }
            }
          }
        } catch { /* Optional sanitized diagnostics must not mask the primary failure or block teardown. */ }
      }
      if (gui) await cleanup('owned GUI exit', async () => { if (await nativeProbe<boolean>(helper, 'alive', String(gui!.pid), gui!.started)) { if (await nativeActions.cleanupTray(String(gui!.pid), gui!.started)) await stopped(gui!) } })
      if (service) await cleanup('owned runtime stop', async () => { if (await nativeProbe<boolean>(helper, 'alive', String(service!.pid), observed.get(service!.pid)!.started)) { if ((await status()).pid !== service!.pid) throw new Error('owner changed'); await control.requestLocalStop(address, 5000, service!.pid) } })
      if (browserIdentity) await cleanup('owned browser close', async () => { if (await nativeProbe<boolean>(helper, 'alive', String(browserIdentity!.pid), browserIdentity!.started)) { await action('close-browser', browserIdentity!); await stopped(browserIdentity!) } })
      // Failed startup may not have produced a window yet. Only this run's unique
      // temp/cache image paths and creation-fenced browser descendants are eligible.
      await cleanup('private process teardown', async () => {
        if (browserIdentity && await nativeProbe<boolean>(helper, 'alive', String(browserIdentity.pid), browserIdentity.started)) {
          const tree = await nativeProbe<Identity[]>(helper, 'children', String(browserIdentity.pid), browserIdentity.started)
          for (const id of tree.reverse()) if (await nativeProbe<boolean>(helper, 'alive', String(id.pid), id.started)) await action('kill-owned', id)
        }
        for (const id of await nativeProbe<Identity[]>(helper, 'scope-processes', scope)) {
          if (await nativeProbe<boolean>(helper, 'alive', String(id.pid), id.started)) { await action('kill-owned', id); await stopped(id) }
        }
        if (launcher && launcher.exitCode === null && launcher.signalCode === null) launcher.kill()
        if (browserProcess && !browserIdentity && browserProcess.exitCode === null) browserProcess.kill()
      })
      await cleanup('URI uninstall', uninstall)
    }
    cdp?.close()
    if (web) await cleanup('Web shutdown', web.stop)
    if (certificate && ownedCertificate(certificate.thumbprint, certificate)) await cleanup('CA removal', () => nativeProbe(helper, 'ca-remove', certificate!.thumbprint))
    await cleanup('service slot release', assertProductServiceIdle)
    if (failure) await writeFile(join(scope, 'cleanup.json'), JSON.stringify({ failed: true, incomplete: errors }))
    if (errors.length && !failure) throw new Error('Incomplete browser E2E cleanup: ' + errors.join(', '))
  }
}
