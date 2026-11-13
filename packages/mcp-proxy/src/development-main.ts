/** Development-only Electron entry: no portable cache publication or automatic URI registration. */
import { app } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { runDesktop } from './desktop-main.ts'

const root = process.env.MCP_PROXY_DEVELOPMENT_ROOT
if (!root || !isAbsolute(root) || !readFileSync(join(root, 'owner.json'), 'utf8')) throw new Error('Run this build through pnpm dev:desktop')
const data = join(root, 'local-app-data/McpProxy/bootstrap')
mkdirSync(data, { recursive: true })
app.setPath('userData', data)
app.setAppLogsPath(join(data, 'logs'))
app.commandLine.appendSwitch('log-file', join(data, 'electron.log'))
process.on('message', (message: unknown) => { if (message === 'mcp-development-stop') app.quit() })
void app.whenReady().then(() => runDesktop(dirname(process.execPath), ['--config', join(root, 'settings.json')], root, false))
  .catch((error: unknown) => { process.stderr.write(`Development desktop failed: ${error instanceof Error ? error.message : 'unknown'}\n`); app.exit(1) })
