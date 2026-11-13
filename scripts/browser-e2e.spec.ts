import { expect, it } from 'vitest'
import { assertDesktopPreflight, requireBrowserMatrix, ownedCertificate, uniqueTarget } from './browser-e2e-contract.ts'

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
