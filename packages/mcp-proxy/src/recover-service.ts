/** Cleanup only the previously observed service after its supervisor has exited. */
import {createConnection} from 'node:net'
import {stopDesktopService} from './service-shutdown.ts'
export interface RecoveryOwner {pid:number;settingsFile:string}
export interface RecoveryOperations {
  exited:()=>boolean
  status:()=>Promise<{pid:number}|undefined>
  snapshot:()=>Promise<RecoveryOwner>
  stop:(pid:number)=>Promise<void>
}
export async function recoverService(owner:RecoveryOwner,operations:RecoveryOperations,timeoutMs=30000,pollMs=100):Promise<void>{
  if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.settingsFile!=='string')throw new Error('Invalid recovery owner')
  if(operations.exited())return
  const key=(path:string)=>process.platform==='win32'?path.toLowerCase():path
  await stopDesktopService({expectedPid:owner.pid,timeoutMs,pollMs,exited:operations.exited,status:operations.status,
    stop:async pid=>{
      const snapshot=await operations.snapshot()
      if(snapshot.pid!==owner.pid||key(snapshot.settingsFile)!==key(owner.settingsFile))throw new Error('Recovery service ownership changed')
      await operations.stop(pid)
    }})
}
/** A missing socket permits waiting for the old process, never assuming it exited. */
export async function assertRecoverySocketAbsent(address:string):Promise<void>{
  const socket=createConnection({path:address}),closed=new Promise<void>(resolve=>socket.once('close',()=>resolve()))
  try{await new Promise<void>((resolve,reject)=>{
    socket.once('connect',()=>reject(new Error('Recovery control remains occupied')))
    socket.once('error',(error:NodeJS.ErrnoException)=>{
      if(error.code==='ENOENT'||error.code==='ECONNREFUSED')resolve();else reject(error)
    })
    socket.setTimeout(1000,()=>reject(new Error('Recovery control probe deadline')))
  })}finally{socket.destroy();await closed}
}
