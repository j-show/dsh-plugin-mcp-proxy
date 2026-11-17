/** Desktop-only administration API; agent/MCP execution remains in the dsh profile. */
export { ManagedSettingsStore } from './settings-store.ts'
export { machineControlAddress, requestLocalManagement, requestLocalStatus, requestLocalStop } from './control.ts'
export { installWindowsUri, uninstallWindowsUri } from './windows-install.ts'
export { installMacosUri, uninstallMacosUri } from './macos-install.ts'
export { installPosixUri, uninstallPosixUri } from './posix-install.ts'
export { parseLocalManagementCommand, parseLocalManagementReply } from '@jshow/app-mcp-proxy/local'
export type { LocalDesktopSnapshot, LocalManagementCommand, LocalManagementReply } from '@jshow/app-mcp-proxy/local'
export { parseProxyActivation } from '@jshow/app-mcp-proxy/protocol'
