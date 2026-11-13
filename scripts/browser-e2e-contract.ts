/** Fail-closed contracts for tests which operate the real Windows desktop. */
export interface DesktopPreflight { platform: string; interactive: boolean; tray: boolean; chrome: boolean; edge: boolean; uriOccupied: boolean }
export function assertDesktopPreflight(p: DesktopPreflight): void {
  if (p.platform !== 'win32') throw new Error('Browser desktop E2E requires Windows')
  if (p.uriOccupied) throw new Error('Existing mcp-proxy URI owner; do not replace it')
  if (!p.interactive) throw new Error('An interactive input desktop is required')
  if (!p.tray) throw new Error('A real Explorer tray is required')
  if (!p.chrome || !p.edge) throw new Error('Both Chrome and Edge are required')
}
export function uniqueTarget<T extends { owned: boolean }>(rows: T[]): T {
  if (rows.length !== 1 || !rows[0]?.owned) throw new Error('Expected exactly one owned native UI target')
  return rows[0]
}
export function ownedCertificate(thumb: string, receipt: { thumbprint: string; added: boolean }): boolean {
  return /^[A-F0-9]{40}$/.test(thumb) && receipt.added && receipt.thumbprint === thumb
}
export const desktopScenarios = ['pair', 'hide', 'trayRestore', 'secondLaunch', 'reconnect', 'trayExit', 'cleanup'] as const
export function requireBrowserMatrix(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Both browser matrices must execute')
  for (const browser of ['chrome', 'edge']) {
    const matches = value.filter(row => row?.browser === browser)
    if (matches.length !== 1 || !desktopScenarios.every(s => matches[0].scenarios?.[s] === true)) throw new Error(`Incomplete ${browser} desktop matrix`)
  }
}
