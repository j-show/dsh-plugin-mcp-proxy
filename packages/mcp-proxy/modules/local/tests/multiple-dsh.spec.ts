import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket, { WebSocketServer } from 'ws'
import { expect, it, onTestFinished, vi } from 'vitest'
import { acceptProxyIdentity, decodeFrame, proveProxyIdentity, ProxyIdentity,
  type DshConnectionId, type InvocationId, type ProxyChannel, type ProxyFrame } from '@jshow/app-mcp-proxy/protocol'
import { attachLocalProxy, LocalInvocationRoutes, LocalMcpPool, resolveLocalServices } from '../src/index.ts'

it('routes identical remote call IDs and MCP sampling through two DSH channels sharing one child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-two-dsh-'))
  const routes = new LocalInvocationRoutes(32)
  const servers: WebSocketServer[] = []
  const clients: WebSocket[] = []
  const channels: ProxyChannel[] = []
  const pool = await LocalMcpPool.open(resolveLocalServices([{ service:'files',transport:'stdio',command:process.execPath,
    args:[fileURLToPath(new URL('./fixtures/files.mjs',import.meta.url))] }],root),{
    maxServices:4,maxFrameBytes:65536,maxDiscoveryPages:8,maxClientRequests:8,maxClientRequestRecords:32,
    startupTimeoutMs:10000,callTimeoutMs:10000,taskCancelTimeoutMs:1000,
  }, request => routes.request(request))
  onTestFinished(async () => {
    await Promise.all(channels.map(channel=>channel.close()))
    await pool.close()
    clients.forEach((client)=>{ client.terminate() })
    await Promise.all(servers.map(server=>new Promise<void>((resolve,reject)=>{
      for(const client of server.clients)client.terminate()
      server.close((error)=>{ if (error) reject(error); else resolve() })
    })))
    await rm(root,{ recursive:true,force:true })
  })
  const catalog=await pool.catalog()
  const before=await pool.call('files','pid',{},new AbortController().signal)
  async function connect(label:string){
    const server=new WebSocketServer({ host:'127.0.0.1',port:0 });servers.push(server)
    await once(server,'listening')
    const address=server.address()
    if(address===null||typeof address==='string')throw new Error('Expected TCP listener')
    const incoming=once(server,'connection')
    const client=new WebSocket(`ws://127.0.0.1:${address.port}`);clients.push(client)
    await once(client,'open')
    const [remote]=await incoming as [WebSocket]
    const done=Promise.withResolvers<Extract<ProxyFrame,{ kind:'result' }>>()
    const origin=`https://${label}.example`
    const hostProof=acceptProxyIdentity(remote,origin,{ maxFrameBytes:65536,timeoutMs:10000 },(peer)=>{
      remote.on('message',(data)=>{
        const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.isBuffer(data)?data:Buffer.from(data)
        const frame=decodeFrame(bytes.toString(),65536)
        if(frame.kind==='callback'){
          expect(frame.parent).toBe('same-remote-call')
          remote.send(JSON.stringify({ v:1,kind:'callback-result',id:frame.id,parent:frame.parent,generation:peer.generation,
            response:{ role:'assistant',model:label,content:{ type:'text',text:label } } }))
        }else if(frame.kind==='result')done.resolve(frame)
        else if(frame.kind==='failure')done.reject(new Error(frame.code))
      })
    })
    let channel:ProxyChannel|undefined
    const localProof=proveProxyIdentity(client,ProxyIdentity.generate(),origin,{ maxFrameBytes:65536,timeoutMs:10000 },(peer)=>{
      channel=attachLocalProxy(client,peer,pool,catalog,{ maxFrameBytes:65536,maxInvocations:32,maxPending:4 },{ routes,
        catalog:revision=>revision===catalog.revision?catalog:undefined,
        owner:{ connectionId:label as DshConnectionId,generation:peer.generation,live:()=>client.readyState===WebSocket.OPEN,
          callback:(r)=>{
            if(channel===undefined)throw new Error('Unbound callback channel')
            return channel.callback(r.invocationId,r.method,r.params,10000,r.signal)
          } },
      });channels.push(channel)
    })
    const [peer]=await Promise.all([hostProof,localProof])
    return { invoke:()=>{
      remote.send(JSON.stringify({ v:1,kind:'invoke',id:'same-remote-call' as InvocationId,generation:peer.generation,
        revision:catalog.revision,service:'files',name:'sample',args:{},timeoutMs:10000 }))
      return done.promise
    } }
  }
  const a=await connect('dsh-a')
  const b=await connect('dsh-b')
  const unavailable = vi.spyOn(pool, 'available', 'get').mockReturnValue(false)
  onTestFinished(() =>{  unavailable.mockRestore() })
  const [first,second]=await Promise.all([a.invoke(),b.invoke()])
  expect(first.result).toMatchObject({ structuredContent:{ sample:{ model:'dsh-a' } } })
  expect(second.result).toMatchObject({ structuredContent:{ sample:{ model:'dsh-b' } } })
  expect(await pool.call('files','pid',{},new AbortController().signal)).toEqual(before)
  expect(clients.every(client => client.readyState === WebSocket.OPEN)).toBe(true)
})
