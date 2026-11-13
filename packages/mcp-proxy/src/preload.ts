/** Sandboxed bridge validating process responses before exposing renderer data. */
import { contextBridge, ipcRenderer } from 'electron'
import { parseLocalManagementReply } from '@j-show/mcp-proxy-local/management'
import type { DesktopBridge, BootstrapState } from './client/api.ts'

const bridge: DesktopBridge = {
  request: async command => parseLocalManagementReply(await ipcRenderer.invoke('mcp-proxy:manage', command)),
  subscribe: (listener) => {
    const receive = (_event: unknown, snapshot: unknown): void => {
      try {
        const reply = parseLocalManagementReply({ ok: true, snapshot })
        if (reply.ok) listener(reply.snapshot)
      } catch (_error) { /* Invalid process data never crosses into the renderer. */ }
    }
    ipcRenderer.on('mcp-proxy:snapshot', receive)
    return () => { ipcRenderer.removeListener('mcp-proxy:snapshot', receive) }
  },
  bootstrap: (listener) => {
    const receive = (_event: unknown, value: unknown): void => {
      if (value === 'starting' || value === 'ready' || value === 'startupFailed' || value === 'protocolFailed' || value === 'stopFailed') {
        listener(value satisfies BootstrapState)
      }
    }
    ipcRenderer.on('mcp-proxy:bootstrap', receive)
    return () => { ipcRenderer.removeListener('mcp-proxy:bootstrap', receive) }
  },
  exit: async () => { await ipcRenderer.invoke('mcp-proxy:exit') },
  registerUri: async () => { await ipcRenderer.invoke('mcp-proxy:register-uri') },
}
contextBridge.exposeInMainWorld('mcpProxy', bridge)
