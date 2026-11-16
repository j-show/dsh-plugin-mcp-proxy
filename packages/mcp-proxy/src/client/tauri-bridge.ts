/** Narrow Tauri bridge; renderer activation and arbitrary shell access remain unavailable. */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { parseLocalManagementReply } from '@j-show/mcp-proxy-local/management'
import type { DesktopState } from '../desktop-host.ts'
import type { DesktopBridge, BootstrapState } from './api.ts'

export async function createTauriBridge(): Promise<DesktopBridge> {
  let state: DesktopState | undefined
  const snapshots = new Set<Parameters<DesktopBridge['subscribe']>[0]>()
  const bootstraps = new Set<(value: BootstrapState) => void>()
  const receive = (value: DesktopState) => {
    if (!['starting','ready','startupFailed','protocolFailed','stopFailed'].includes(value.bootstrap)) return
    if (value.snapshot) {
      const reply = parseLocalManagementReply({ ok: true, snapshot: value.snapshot })
      if (!reply.ok) return
      for (const listener of snapshots) listener(reply.snapshot)
    }
    state = value
    for (const listener of bootstraps) listener(value.bootstrap)
  }
  await listen<DesktopState>('desktop-state', event => receive(event.payload))
  const initial = await invoke<DesktopState | null>('desktop_state')
  if (initial) receive(initial)
  return {
    request: async command => parseLocalManagementReply(await invoke('desktop_request', { command })),
    subscribe: listener => { snapshots.add(listener); if (state?.snapshot) listener(state.snapshot); return () => { snapshots.delete(listener) } },
    bootstrap: listener => { bootstraps.add(listener); if (state) listener(state.bootstrap); return () => { bootstraps.delete(listener) } },
    exit: () => invoke('desktop_exit'), registerUri: () => invoke('desktop_register'),
    confirm: message => invoke<boolean>('desktop_confirm', { message }),
  }
}
