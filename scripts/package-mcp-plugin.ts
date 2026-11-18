/** Pack a delivery workspace with all internal source already bundled. */
import {mkdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pnpmInvocation,runMcpBuildCommand} from './run-mcp-build-command.ts'
import {tarballFiles} from './archive-members.ts'
export async function packageMcpPlugin(root:string,_work:string,output:string,owner='dsh-plugin'):Promise<string>{
 const directory=join(root,'packages',owner),manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
 await mkdir(output,{recursive:true})
 const invocation=pnpmInvocation(['--config.verify-deps-before-run=false','--dir',directory,'pack','--pack-destination',output])
 await runMcpBuildCommand(invocation.command,invocation.args,root)
 const archive=join(output,manifest.name.replace('@','').replace('/','-')+'-'+manifest.version+'.tgz'),members=tarballFiles(archive)
 if(owner==='dsh-plugin')validateMcpPluginMembers(members)
 else for(const file of ['runtime.js','runtime-startup.js','runtime-desktop.js'])if(!members.includes('package/lib/'+file))throw new Error('Incomplete application package: '+file)
 return archive
}
export function validateMcpPluginMembers(members:readonly string[]):void{
 if(members.some(member=>!member.startsWith('package/')||member.split('/').includes('..')))throw new Error('MCP archive contains a path outside its package')
 for(const file of ['lib/index.js','lib/client.js','cordis.patch.yml','LICENSE'])if(!members.includes('package/'+file))throw new Error('Bundled entry or license missing: '+file)
 // Reject nested current delivery packages.
 if(members.some(member=>member.startsWith('package/node_modules/@jshow/')))throw new Error('Internal package leaked into archive')
}
