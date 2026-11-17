import { expect, it } from 'vitest'
import type { GenerationId, DshConnectionId, InvocationId, ProxyFrame } from '@jshow/app-mcp-proxy/protocol'
import { LocalInvocationRoutes, type LocalDshOwner } from '../src/routing.ts'

const generation = 'same-generation' as GenerationId
const frame: Extract<ProxyFrame, { kind:'invoke' }> = { v:1,kind:'invoke',generation,id:'same-id' as InvocationId,
  revision:'revision' as Extract<ProxyFrame,{ kind:'catalog' }>['revision'],service:'files',name:'sample',args:{},timeoutMs:1000 }
const owner = (id:string):LocalDshOwner => ({ connectionId:id as DshConnectionId,generation,live:()=>true,
  callback:async r=>({ dsh:id,parent:r.invocationId }) })

it('keeps equal remote IDs from two DSHs separate through callbacks and reverse completion', async()=>{
  const routes=new LocalInvocationRoutes(8)
  const a=Promise.withResolvers<undefined>()
  const b=Promise.withResolvers<undefined>()
  const ids:InvocationId[]=[]
  const call=(dsh:LocalDshOwner,done:Promise<undefined>)=>routes.run(dsh,frame,new AbortController().signal,async (id)=>{
    ids.push(id);await done
    return routes.request({ invocationId:id,service:'files',method:'sampling',params:{},signal:new AbortController().signal })
  })
  const first=call(owner('a'),a.promise)
  const second=call(owner('b'),b.promise)
  b.resolve(undefined);expect(await second).toEqual({ dsh:'b',parent:'same-id' })
  a.resolve(undefined);expect(await first).toEqual({ dsh:'a',parent:'same-id' })
  expect(ids[0]).not.toBe(ids[1])
  await expect(routes.request({ invocationId:ids[0]!,service:'files',method:'sampling',params:{},signal:new AbortController().signal })).rejects.toThrow()
})

it('refuses a cancelled or replaced DSH without cancelling another origin',async()=>{
  const routes=new LocalInvocationRoutes(8)
  const stop=new AbortController()
  const started=Promise.withResolvers<InvocationId>()
  const release=Promise.withResolvers<undefined>()
  const a=routes.run(owner('a'),frame,stop.signal,async (id)=>{started.resolve(id);await release.promise;return 'late'})
  const rejected=expect(a).rejects.toThrow()
  const id=await started.promise
  stop.abort()
  await expect(routes.request({ invocationId:id,service:'files',method:'sampling',params:{},signal:new AbortController().signal })).rejects.toThrow()
  expect(await routes.run(owner('b'),frame,new AbortController().signal,async()=> 'b')).toBe('b')
  release.resolve(undefined);await rejected
  await expect(routes.run({ ...owner('a'),live:()=>false },frame,new AbortController().signal,async()=> 'wrong')).rejects.toThrow()
  await expect(routes.run(owner('a'),{ ...frame,generation:'wrong' as GenerationId },new AbortController().signal,async()=> 'wrong')).rejects.toThrow()
})
