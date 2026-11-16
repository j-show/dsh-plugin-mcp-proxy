import {expect,it,vi} from 'vitest'
import {recoverService,assertRecoverySocketAbsent} from '../src/recover-service.ts'
import {createServer} from 'node:net'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const owner={pid:12345,settingsFile:'fixture/settings.json'}
it('does not stop a replacement owner after the observed service has exited',async()=>{
  const status=vi.fn(),snapshot=vi.fn(),stop=vi.fn()
  await recoverService(owner,{exited:()=>true,status,snapshot,stop})
  expect(status).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled()
})
it('distinguishes an absent private control endpoint from an occupied one and closes its probe',async()=>{
  const name='mcp-recovery-'+randomUUID(),address=process.platform==='win32'?'\\\\.\\pipe\\'+name:join(tmpdir(),name)
  await assertRecoverySocketAbsent(address)
  const server=createServer(socket=>socket.resume());server.listen(address);await once(server,'listening')
  try{await expect(assertRecoverySocketAbsent(address)).rejects.toThrow('occupied')}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
})
it('waits for actual exit when the control socket is already absent',async()=>{
  let checks=0;const stop=vi.fn()
  await recoverService(owner,{exited:()=>++checks>=3,status:async()=>undefined,snapshot:async()=>owner,stop},100,1)
  expect(checks).toBeGreaterThanOrEqual(3);expect(stop).not.toHaveBeenCalled()
})
it.each([{...owner,pid:54321},{...owner,settingsFile:'fixture/other.json'}])('refuses changed recovery identity %j',async snapshot=>{
  const stop=vi.fn()
  await expect(recoverService(owner,{exited:()=>false,status:async()=>({pid:owner.pid}),snapshot:async()=>snapshot,stop},100,1)).rejects.toThrow('ownership changed')
  expect(stop).not.toHaveBeenCalled()
})
