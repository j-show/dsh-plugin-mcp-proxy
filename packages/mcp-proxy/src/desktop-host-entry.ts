/** Private stdio RPC between Tauri and its bundled Node supervisor. */
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { DesktopHost, desktopDataDirectory, type DesktopHostOptions } from './desktop-host.ts'
import { ensureLocalProfile } from './ensure-profile.ts'

const send = (value: unknown) => { process.stdout.write(JSON.stringify(value) + '\n') }
async function administrative(options: DesktopHostOptions): Promise<void> {
  const home = process.env.DSH_HOME || join(desktopDataDirectory(process.platform, process.env, homedir()), 'data/dsh')
  await ensureLocalProfile(dirname(options.resources), home)
  if (options.args.includes('--install') || options.args.includes('--uninstall')) {
    const args = options.args.filter(value => value !== '--install' && value !== '--uninstall')
    await new DesktopHost({ ...options, args }, () => {}).installUri(options.args.includes('--uninstall'))
    return
  }
  const child = spawn(join(options.resources, 'dsh/runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    [join(options.resources, 'dsh/lib/bin.js'), '--profile', 'mcp-proxy', ...options.args],
    { cwd: options.cwd, env: { ...process.env, DSH_HOME: home }, stdio: 'inherit', windowsHide: true, shell: false })
  const [code, signal] = await once(child, 'exit') as [number | null, string | null]
  if (code !== 0 || signal !== null) throw new Error('Administrative command failed')
}
if (process.argv[2] === '--admin') {
  try { await administrative(JSON.parse(process.argv[3]!) as DesktopHostOptions) }
  catch { process.stderr.write('mcp-proxy: administrative operation failed\n'); process.exitCode = 1 }
} else {
  let host: DesktopHost | undefined
  const lines = createInterface({ input: process.stdin, terminal: false })
  lines.on('line', line => {
    void (async () => {
      if (Buffer.byteLength(line) > 1048576) throw new Error('Desktop frame limit')
      const request = JSON.parse(line) as { id: number; command: string; payload: unknown }
      if (!Number.isSafeInteger(request.id) || request.id < 1) throw new Error('Invalid desktop request')
      try {
        let result: unknown = null
        if (request.command === 'start' && !host) {
          host = new DesktopHost(request.payload as DesktopHostOptions, (event, payload) => send({ event, payload }))
          result = await host.start()
        } else if (request.command === 'manage' && host) result = await host.manage(request.payload)
        else if (request.command === 'activate' && host && typeof request.payload === 'string') await host.activate(request.payload)
        else if (request.command === 'register' && host) await host.registerUri()
        else if (request.command === 'shutdown') await host?.close()
        else throw new Error('Unknown desktop command')
        if (request.command === 'shutdown') {
          process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n', () => { process.exit(0) })
        } else send({ id: request.id, ok: true, result })
      } catch {
        const stage=['start','manage','activate','register','shutdown'].includes(request.command)?request.command:'invalid'
        process.stderr.write(`mcp-proxy: desktop-${stage} failed\n`)
        send({ id: request.id, ok: false, error: 'Local desktop operation failed' })
      }
    })().catch(() => { process.stderr.write('mcp-proxy: invalid private desktop frame\n') })
  })
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void (host?.close() ?? Promise.resolve()).then(() => { process.exit(0) }, () => { process.exit(1) })
  }
  lines.on('close', stop)
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}
