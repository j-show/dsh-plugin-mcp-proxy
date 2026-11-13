import { createServer } from 'node:net'
const server = createServer(socket => socket.destroy())
server.listen(process.argv[2], () => process.stdout.write('ready\n'))
