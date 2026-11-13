import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

it('routes an owned IPC shutdown request through the application signal handler', async () => {
  const child = spawn(process.execPath, ['--import', new URL('./development-signals.mjs', import.meta.url).href,
    '--input-type=module', '-e', "const timer=setInterval(()=>{},1000);process.on('SIGINT',()=>{clearInterval(timer);process.send('disposed');process.disconnect()});process.send('ready')"],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  const exited = once(child, 'exit')
  try {
    expect((await once(child, 'message'))[0]).toBe('ready')
    const disposed = once(child, 'message')
    child.send('mcp-development-stop')
    expect((await disposed)[0]).toBe('disposed')
    expect((await exited)[0]).toBe(0)
  } finally { if (child.exitCode === null) { child.kill(); await exited } }
})

it('does not keep a one-shot CLI command alive for its shutdown channel', async () => {
  const child = spawn(process.execPath, ['--import', new URL('./development-signals.mjs', import.meta.url).href, '-e', ''],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  const exit = once(child, 'exit')
  try { expect((await exit)[0]).toBe(0) } finally { if (child.exitCode === null) { child.kill(); await exit } }
})
