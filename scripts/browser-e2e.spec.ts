import { expect, it, onTestFinished } from 'vitest'
import { copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertDesktopPreflight, requireBrowserMatrix, ownedCertificate, uniqueTarget, activeMcpIdentities } from './browser-e2e-contract.ts'
import { BrowserCdp, prepareDshPage, safeBrowserDiagnostic, verifyPageBoots } from './browser-cdp.ts'
import { compileDesktopProbe, nativeProbe, nativeActionSession, nativeConfirmationPoll, confirmNativeAction, confirmNativeProtocol } from './browser-native.ts'

it('refuses existing URI owners and noninteractive desktops before touching user state', () => {
  const ready = { platform: 'win32', interactive: true, tray: true, chrome: true, edge: true, uriOccupied: false }
  expect(() => assertDesktopPreflight(ready)).not.toThrow()
  expect(() => assertDesktopPreflight({ ...ready, uriOccupied: true })).toThrow('URI')
  expect(() => assertDesktopPreflight({ ...ready, interactive: false })).toThrow('interactive')
  expect(() => assertDesktopPreflight({ ...ready, tray: false })).toThrow('tray')
  expect(() => assertDesktopPreflight({ ...ready, edge: false })).toThrow('Edge')
})
it('requires a unique owned native UI target rather than clicking a guessed window', () => {
  expect(uniqueTarget([{ pid: 1, owned: true }])).toEqual({ pid: 1, owned: true })
  expect(() => uniqueTarget([{ pid: 2, owned: false }])).toThrow()
  expect(() => uniqueTarget([{ pid: 1, owned: true }, { pid: 2, owned: true }])).toThrow()
})
it('never removes a certificate unless its exact newly imported fingerprint is owned', () => {
  const thumb = 'A'.repeat(40)
  expect(ownedCertificate(thumb, { thumbprint: thumb, added: true })).toBe(true)
  expect(ownedCertificate(thumb, { thumbprint: 'B'.repeat(40), added: true })).toBe(false)
  expect(ownedCertificate(thumb, { thumbprint: thumb, added: false })).toBe(false)
})
it('requires both browsers and every real lifecycle action without silent skips', () => {
  const scenarios = ['pair', 'hide', 'trayRestore', 'secondLaunch', 'reconnect', 'trayExit', 'cleanup']
  const rows = ['chrome', 'edge'].map(browser => ({ browser, scenarios: Object.fromEntries(scenarios.map(s => [s, true])),
    guards: { webDocumentRejected: true, documentDepth: 50, ancestorLimit: 32, trayOcclusionRefused: true } }))
  expect(() => requireBrowserMatrix(rows)).not.toThrow()
  expect(() => requireBrowserMatrix(rows.slice(0, 1))).toThrow()
  expect(() => requireBrowserMatrix([{ ...rows[0], scenarios: { ...rows[0]!.scenarios, trayExit: false } }, rows[1]])).toThrow()
  expect(() => requireBrowserMatrix([{ ...rows[0], guards: undefined }, rows[1]])).toThrow('safety guards')
  expect(() => requireBrowserMatrix([{ ...rows[0], guards: { ...rows[0]!.guards, documentDepth: 32 } }, rows[1]])).toThrow('safety guards')
})
it('ignores already-exited negotiation children but refuses live unowned markers', () => {
  const owned = { pid: 2, started: 'owned' }
  expect(activeMcpIdentities([1, 2, 2], [owned], () => false)).toEqual([owned])
  expect(() => activeMcpIdentities([1, 2], [owned], pid => pid === 1)).toThrow('Cannot attribute')
  expect(() => activeMcpIdentities([1], [], () => false)).toThrow('No live')
})
it('uses the real notice and optional model controls once before opening settings', async () => {
  const pages = [{ notice: true }, { notice: true }, { model: true }, { model: true }, { ready: true }]
  const clicks: string[] = []
  await prepareDshPage({ evaluate: async <T>() => pages.shift() as T, clickText: async pattern => { clicks.push(pattern) } })
  expect(clicks).toHaveLength(2)
  expect(new RegExp(clicks[0]!, 'i').test('Continue')).toBe(true)
  expect(new RegExp(clicks[1]!, 'i').test('Configure later')).toBe(true)
})
it('retries pre-input protocol refusals but never replays uncertain input or an unreported helper exit', async () => {
  let attempts = 0
  await confirmNativeProtocol(async () => { if (++attempts === 1) throw new Error('Native operation confirm-protocol failed: Native desktop test: Exception: Protocol button did not acquire keyboard focus') })
  expect(attempts).toBe(2)
  attempts = 0
  await confirmNativeAction('confirm-disconnect', async () => { if (++attempts === 1) throw new Error('Native operation confirm-disconnect failed: Native desktop test: Exception: Expected one matching native control; found 0') })
  expect(attempts).toBe(2)
  for (const operation of ['confirm-protocol', 'confirm-disconnect']) {
    for (const message of [`Native operation ${operation} failed: Native desktop test: Exception: Native input result uncertain; refusing retry`,
      `Native operation ${operation} failed (timeout)`, `Native operation ${operation} failed`]) {
      attempts = 0
      await expect(confirmNativeAction(operation, async () => { attempts++; throw new Error(message) })).rejects.toThrow(message)
      expect(attempts).toBe(1)
    }
  }
})
it.skipIf(process.platform !== 'win32')('reads a suspended process image before modules load and terminates the native fixture', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-browser-image-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const helper = await compileDesktopProbe(directory)
  const fixture = join(directory, 'mcp-proxy.exe'); await copyFile(helper, fixture)
  const value = await nativeProbe<{ pid: number; started: string; image: string; mainModuleUnavailable: boolean }>(helper, 'process-image-fixture', fixture)
  expect(value.mainModuleUnavailable).toBe(true)
  expect((await realpath(value.image)).toLowerCase()).toBe((await realpath(fixture)).toLowerCase())
  expect(await nativeProbe(helper, 'alive', String(value.pid), value.started)).toBe(false)
})
it('falls back to owned process cleanup without replaying uncertain tray input', async () => {
  for (const message of ['Native operation tray-exit failed: Native desktop test: Exception: Native input result uncertain; refusing retry',
    'Native operation tray-exit failed (timeout)', 'Native operation tray-exit failed']) {
    const calls: string[] = []
    const session = nativeActionSession(async operation => { calls.push(operation); throw new Error(message) })
    await expect(session.action('tray-exit', '123', 'owned')).rejects.toThrow(message)
    expect(await session.cleanupTray('123', 'owned')).toBe(false)
    expect(calls).toEqual(['tray-exit'])
  }
  const calls: string[] = []
  const session = nativeActionSession(async operation => {
    calls.push(operation)
    if (operation === 'tray-click') throw new Error('Native operation tray-click failed: Native desktop test: Exception: Notification pointer refused')
  })
  await expect(session.action('tray-click')).rejects.toThrow('refused')
  expect(await session.cleanupTray('123', 'owned')).toBe(true)
  expect(calls).toEqual(['tray-click', 'tray-exit'])
})
it('dispatches certificate confirmation once across overlapping and later polling ticks', async () => {
  let calls = 0, release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const poll = nativeConfirmationPoll('confirm-ca', async () => { calls++; await pending; return true })
  const first = poll(); await poll(); expect(calls).toBe(1)
  release(); await first; await poll(); expect(calls).toBe(1)
  calls = 0
  const refused = nativeConfirmationPoll('confirm-ca', async () => {
    if (++calls === 1) throw new Error('Native operation confirm-ca failed: Native desktop test: Exception: Owned warning not found')
    return true
  })
  await refused(); await refused(); await refused(); expect(calls).toBe(2)
  for (const message of ['Native operation confirm-ca failed: Native desktop test: Exception: Native input result uncertain',
    'Native operation confirm-ca failed (timeout)', 'Native operation confirm-ca failed']) {
    calls = 0
    const unknown = nativeConfirmationPoll('confirm-ca', async () => { calls++; throw new Error(message) })
    await unknown(); await unknown(); expect(calls).toBe(1)
  }
})
it.skipIf(process.platform !== 'win32')('recognizes protocol app names in sentences without accepting lookalike names', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-browser-brand-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const helper = await compileDesktopProbe(directory), input = join(directory, 'messages.json')
  const cases: Array<[string, boolean]> = [
    ['Open mcp-proxy?', true], ['This site is trying to open mcp-proxy.', true], ['This site is trying to open mcp-proxy.exe.', true],
    ['“mcp-proxy”', true], ['打开 mcp-proxy。', true], ['mcp-proxy. Another sentence.', true],
    ['not-mcp-proxy', false], ['not.mcp-proxy', false], ['prefixmcp-proxy', false], ['mcp-proxy-evil', false],
    ['mcp-proxy_foo', false], ['mcp-proxy.foo', false], ['mcp-proxy.exe.old', false], ['mcp-proxy..bad', false],
  ]
  await writeFile(input, JSON.stringify(cases.map(([text]) => text)))
  expect(await nativeProbe(helper, 'protocol-brand-fixture', input)).toEqual(cases.map(([, expected]) => expected))
})
it('retains useful client errors while omitting credentials, activation tickets and URL queries', () => {
  const ticket = 'a'.repeat(43)
  const error = safeBrowserDiagnostic(`TypeError: locale register at https://user:pass@localhost:3443/client.js?token=${ticket}#private mcp-proxy://associate/${ticket}?v=2 user@example.com`)
  expect(error).toContain('TypeError: locale register')
  for (const value of [ticket, 'user:pass', '#private', '?token=', 'user@example.com', 'mcp-proxy://associate/']) expect(error).not.toContain(value)
  for (const value of ['Authorization: Bearer short', 'Cookie: local=value', 'password=short', '-----BEGIN PRIVATE KEY-----']) {
    expect(safeBrowserDiagnostic(value)).toBe('[sensitive diagnostic omitted]')
  }
})
it('requires every fresh page boot and stops at the first activation failure without retry', async () => {
  const calls: string[] = []
  await expect(verifyPageBoots(4, async index => {
    calls.push('navigate'+index)
    if(index===2)throw new Error('plugin activation failed')
  })).rejects.toThrow('plugin activation failed')
  expect(calls).toEqual(['navigate0','navigate1','navigate2'])
})
it('reports a browser process exit before waiting for a missing debugging file', async () => {
  await expect(BrowserCdp.page('unused-profile', undefined, () => { throw new Error('Browser exited: code=23') }))
    .rejects.toThrow('Browser exited: code=23')
})
