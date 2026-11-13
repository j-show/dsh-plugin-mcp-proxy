import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { onTestFinished } from 'vitest'

export async function openSockets() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const owned: { client?: WebSocket } = {}
  onTestFinished(async () => {
    owned.client?.terminate()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
  })
  await once(server, 'listening')
  const connected = once(server, 'connection')
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`)
  const upgraded = once(client, 'upgrade')
  owned.client = client
  await once(client, 'open')
  const [remote, request] = await connected as [WebSocket, IncomingMessage]
  const [response] = await upgraded as [IncomingMessage]
  return { client, remote, carrier: request.socket, clientCarrier: response.socket }
}

