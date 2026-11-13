import { expect, it, onTestFinished } from 'vitest'
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertDesktopPreflight, requireBrowserMatrix, ownedCertificate, uniqueTarget, activeMcpIdentities } from './browser-e2e-contract.ts'
import { prepareDshPage } from './browser-cdp.ts'
import { compileDesktopProbe, nativeProbe, nativeActionSession, confirmNativeProtocol } from './browser-native.ts'

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
  const rows = ['chrome', 'edge'].map(browser => ({ browser, scenarios: Object.fromEntries(scenarios.map(s => [s, true])) }))
  expect(() => requireBrowserMatrix(rows)).not.toThrow()
  expect(() => requireBrowserMatrix(rows.slice(0, 1))).toThrow()
  expect(() => requireBrowserMatrix([{ ...rows[0], scenarios: { ...rows[0]!.scenarios, trayExit: false } }, rows[1]])).toThrow()
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
  for (const message of ['Native operation confirm-protocol failed: Native desktop test: Exception: Native protocol input result uncertain; refusing retry',
    'Native operation confirm-protocol failed (timeout)', 'Native operation confirm-protocol failed']) {
    attempts = 0
    await expect(confirmNativeProtocol(async () => { attempts++; throw new Error(message) })).rejects.toThrow(message)
    expect(attempts).toBe(1)
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
