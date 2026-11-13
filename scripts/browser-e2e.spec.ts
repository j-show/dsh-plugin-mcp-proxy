import { expect, it } from 'vitest'
import { assertDesktopPreflight, requireBrowserMatrix, ownedCertificate, uniqueTarget, activeMcpIdentities } from './browser-e2e-contract.ts'
import { prepareDshPage } from './browser-cdp.ts'

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
