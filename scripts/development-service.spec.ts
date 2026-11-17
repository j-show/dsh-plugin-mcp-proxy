import {expect,it,onTestFinished} from 'vitest'
import {createServer} from 'node:net'
import {once} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {assertDevelopmentServiceIdle} from './development-service.ts'

it('refuses an occupied native control address without sending commands or stopping its owner',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dev-slot-'))
  const address=process.platform==='win32'?`\\\\.\\pipe\\mcp-dev-test-${process.pid}-${Date.now()}`:join(root,'service.sock')
  let bytes=0
  const server=createServer(socket=>{socket.on('data',data=>{bytes+=data.length});socket.on('error',()=>{})})
  onTestFinished(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})})
  server.listen(address);await once(server,'listening')
  await expect(assertDevelopmentServiceIdle(async()=>address)).rejects.toThrow('unused machine service slot')
  expect(server.listening).toBe(true)
  expect(bytes).toBe(0)
})
