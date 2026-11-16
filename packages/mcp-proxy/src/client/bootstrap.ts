import { createTauriBridge } from './tauri-bridge.ts'
window.mcpProxy = await createTauriBridge()
await import('./renderer.ts')
