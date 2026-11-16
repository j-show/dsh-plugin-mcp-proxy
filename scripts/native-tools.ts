/** Windows builds must not inherit MSYS tar's drive-letter-as-remote interpretation. */
import {win32} from 'node:path'
export function nativeTar(platform: NodeJS.Platform=process.platform,environment:NodeJS.ProcessEnv=process.env,architecture:NodeJS.Architecture=process.arch):string {
  if(platform!=='win32')return 'tar'
  const root=Object.entries(environment).find(([key])=>key.toLowerCase()==='systemroot')?.[1]
    ??Object.entries(environment).find(([key])=>key.toLowerCase()==='windir')?.[1]
  if(!root||!win32.isAbsolute(root))throw new Error('Windows system directory is required for native tar')
  return win32.join(root,architecture==='ia32'&&environment.PROCESSOR_ARCHITEW6432?'Sysnative':'System32','tar.exe')
}
