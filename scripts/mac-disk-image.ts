/** Build a plain read-only DMG without Finder layout or an externally mounted staging volume. */
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {cp,mkdir,mkdtemp,symlink} from 'node:fs/promises'
import {join,dirname} from 'node:path'
export async function createMacDiskImage(application:string,destination:string,stage:string,privileged=process.env.MCP_PROXY_DMG_PRIVILEGED==='1'):Promise<void>{
  const input=await mkdtemp(join(stage,'disk-image-'))
  await cp(application,join(input,'mcp-proxy.app'),{recursive:true,verbatimSymlinks:true})
  await symlink('/Applications',join(input,'Applications'))
  await mkdir(dirname(destination),{recursive:true})
  const args=['create','-verbose','-ov','-volname','mcp-proxy','-fs','HFS+','-format','UDZO','-srcfolder',input,destination]
  await promisify(execFile)(privileged?'/usr/bin/sudo':'hdiutil',privileged?['-n','/usr/bin/hdiutil',...args]:args,
    {timeout:300000,maxBuffer:1048576})
}
