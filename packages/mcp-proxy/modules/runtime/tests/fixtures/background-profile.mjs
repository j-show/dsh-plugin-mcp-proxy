import { createServer } from 'node:net'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

if (process.argv[2] !== '--profile' || process.argv[4] !== '--config' || process.argv.length !== 6) process.exit(3)
const settings = JSON.parse(await readFile(process.argv[5], 'utf8'))
if (settings.fail) { process.stderr.write('fixture startup failed\n'); process.exit(5) }
let descendant
let descendantExit
if (settings.descendant) {
  descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] })
  descendantExit = once(descendant, 'exit')
  await once(descendant.stdout, 'data')
}
const observed = settings.observed + '.pending-' + process.pid
await writeFile(observed, JSON.stringify({ args: process.argv.slice(2), pid: process.pid, home: process.env.DSH_HOME, cwd: process.cwd(),
  ...(descendant === undefined ? {} : { descendant: descendant.pid }),
}))
await rename(observed, settings.observed)
const server = createServer(socket => {
  socket.once('data', data => {
    if (data.toString() === 'STATUS\n') socket.end(`PID ${settings.foreignStatus ? process.ppid : process.pid} ${settings.ready ? 'ready' : 'starting'}\n`)
    else if (data.toString() === 'STOP\n' || data.toString() === `STOP ${process.pid}\n`) {
      if (settings.ignoreStop) return
      socket.end('OK\n', async () => {
        descendant?.kill('SIGKILL')
        await descendantExit
        server.close(() => process.exit(0))
      })
    }
    else socket.end('ERROR\n')
  })
})
server.listen(settings.address)
