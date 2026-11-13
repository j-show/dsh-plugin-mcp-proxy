/** Checksum-verified runtime downloads, cached only inside build artifacts. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
export async function downloadPrimaryRuntimeAsset(url:string, sha256:string, cache:string):Promise<string> {
 const destination=join(cache,sha256)
 let bytes:Buffer
 let downloaded=false
 try { bytes=await readFile(destination) } catch(error) {
  if(!(error instanceof Error) || !('code' in error) || error.code!=='ENOENT')throw error
  const response=await fetch(url,{signal:AbortSignal.timeout(300000)})
  if(!response.ok)throw new Error('Runtime download failed: '+response.status)
  bytes=Buffer.from(await response.arrayBuffer())
  downloaded=true
 }
 if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error('Runtime checksum mismatch')
 if(downloaded){
  const pending=join(cache,randomUUID()+'.pending')
  await writeFile(pending,bytes,{flag:'wx'})
  try { await link(pending,destination) } catch(error) {
   if(!(error instanceof Error)||!('code'in error)||error.code!=='EEXIST')throw error
   if(createHash('sha256').update(await readFile(destination)).digest('hex')!==sha256)throw new Error('Runtime checksum mismatch')
  } finally { await unlink(pending) }
 }
 return destination
}
