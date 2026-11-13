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
/** Negotiation can retire a startup child; never attach an exited/reused marker to an unrelated process. */
export function activeMcpIdentities<T extends { pid: number }>(markers: number[], tree: T[], running: (pid: number) => boolean): T[] {
  const selected: T[] = []
  for (const pid of new Set(markers)) {
    const identity = tree.find(row => row.pid === pid)
    if (identity) selected.push(identity)
    else if (running(pid)) throw new Error('Cannot attribute a live MCP marker PID to the owned service')
  }
  if (!selected.length) throw new Error('No live test MCP belongs to the GUI service')
  return selected
}
export function requireBrowserMatrix(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Both browser matrices must execute')
  for (const browser of ['chrome', 'edge']) {
    const matches = value.filter(row => row?.browser === browser)
    if (matches.length !== 1 || !desktopScenarios.every(s => matches[0].scenarios?.[s] === true)) throw new Error(`Incomplete ${browser} desktop matrix`)
    const guards = matches[0].guards
    if (guards?.webDocumentRejected !== true || guards?.trayOcclusionRefused !== true || !Number.isSafeInteger(guards?.ancestorLimit)
      || guards.ancestorLimit < 1 || !Number.isSafeInteger(guards?.documentDepth) || guards.documentDepth <= guards.ancestorLimit) throw new Error(`Incomplete ${browser} native safety guards`)
  }
}
