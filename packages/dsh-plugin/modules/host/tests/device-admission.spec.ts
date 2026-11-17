import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import WebSocket from 'ws'
import { expect, it, onTestFinished } from 'vitest'
import { pairingChallenge, ProxyIdentity, proveProxyIdentity, ProxyChannel, type BrowserBindingId } from '@jshow/app-mcp-proxy/protocol'
import Host from '../src/index.ts'
import { openHost } from './helpers/composition.ts'

it('admits a browser-paired device without the shared deployment secret and rejects ticket replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-device-admission-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const { ctx, origin } = await openHost(4, [], { name:'device-host',module:Host,config:(publicOrigin,credentialRef)=>({
    publicOrigin,credentialRef,admission:'device',deviceRegistryFile:join(root,'devices.json'),handshakeTimeoutMs:2000,
  }) })
  const browser = 'paired-browser' as BrowserBindingId
  const association = ctx.mcpProxy.beginAssociation(browser)
  const device = ProxyIdentity.generate()
  const registration = device.registration(pairingChallenge(origin, association.requestId), origin)
  async function redeem() {
    return new Promise<{ status:number;body:string }>((resolve,reject)=>{
      const req=request({ hostname:'127.0.0.1',port:ctx.webServer.port,path:'/mcp-proxy/pair',method:'POST',
        headers:{ Host:new URL(origin).host,'Content-Type':'application/json' } },(res)=>{
        let body='';res.setEncoding('utf8');res.on('data',(part)=>{body+=part});res.on('error',reject)
        res.on('end',()=>{resolve({ status:res.statusCode??0,body })})
      })
      req.on('error',reject);req.end(JSON.stringify({ requestId:association.requestId,registration }))
    })
  }
  expect((await redeem()).status).toBe(200)
  expect((await redeem()).status).not.toBe(200)
  expect(() => ctx.mcpProxy.associations.finish(association.requestId,browser)).toThrow()
  const socket=new WebSocket(`ws://127.0.0.1:${ctx.webServer.port}/mcp-proxy/connect`,{
    headers:{ Host:new URL(origin).host,Authorization:`Device ${device.endpointId}` },
  })
  onTestFinished(()=>{socket.terminate()})
  let channel:ProxyChannel|undefined
  await new Promise<void>((resolve,reject)=>{
    socket.once('error',reject)
    socket.once('open',()=>{
      void proveProxyIdentity(socket,device,origin,{ timeoutMs:2000,maxFrameBytes:65536 },(peer)=>{
        channel=new ProxyChannel(socket,{ generation:peer.generation,maxFrameBytes:65536,maxInvocations:8,maxPending:4 })
      }).then(() => { resolve() },reject)
    })
  })
  onTestFinished(async()=>{await channel?.close()})
  const acknowledged=once(socket,'message')
  socket.send(JSON.stringify({ v:1,kind:'catalog',revision:'empty',services:[],tools:[] }))
  await acknowledged
  socket.send(JSON.stringify({ v:1,kind:'association',requestId:association.requestId }))
  await expect.poll(()=>{
    try{return ctx.mcpProxy.associations.finish(association.requestId,browser).handle}catch(_error){return undefined}
  }).toBeTypeOf('string')
})
