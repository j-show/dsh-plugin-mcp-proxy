/** Sandboxed renderer bridge; no arbitrary IPC channels or Node APIs are exposed. */
import type { LocalManagementCommand, LocalManagementReply, LocalDesktopSnapshot } from '@jshow/app-mcp-proxy/local/management'

/** The activation command is reserved for the native/main-process entry. */
export type GuiCommand = Exclude<LocalManagementCommand, { kind: 'activate' }>
/** Local bootstrap feedback independent of DSH network state. */
export type BootstrapState = 'starting' | 'ready' | 'startupFailed' | 'protocolFailed' | 'stopFailed'
/** Narrow desktop capability exposed to the bundled local page. */
export interface DesktopBridge {
  request(command: GuiCommand): Promise<LocalManagementReply>
  subscribe(listener: (snapshot: LocalDesktopSnapshot) => void): () => void
  bootstrap(listener: (state: BootstrapState) => void): () => void
  exit(): Promise<void>
  registerUri(): Promise<void>
  confirm(message: string): Promise<boolean>
}
declare global { interface Window { mcpProxy: DesktopBridge } }
