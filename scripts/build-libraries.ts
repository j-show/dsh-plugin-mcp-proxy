/** Bundle ordinary source modules into the two delivery packages. */
import {readFile,readdir,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {build} from 'tsdown'
import {runMcpBuildCommand} from './run-mcp-build-command.ts'
import {buildBrowserClient} from './build-browser.ts'
export async function buildLibraries(root:string,development=false):Promise<void>{
 await runMcpBuildCommand(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-b',join(root,'tsconfig.json')],root)
 const app={runtime:'modules/runtime/src/index.ts','runtime-startup':'modules/runtime/src/startup.ts','runtime-desktop':'modules/runtime/src/desktop.ts',protocol:'modules/protocol/src/index.ts','protocol-activation':'modules/protocol/src/activation.ts',local:'modules/local/src/index.ts','local-management':'modules/local/src/management.ts'}
 const plugin={index:'src/index.ts',host:'modules/host/src/index.ts',agent:'modules/agent/src/index.ts',browser:'modules/browser/src/index.ts',ui:'modules/ui/src/index.ts',protocol:'../mcp-proxy/modules/protocol/src/index.ts'}
 for(const [owner,entry] of [['mcp-proxy',app],['dsh-plugin',plugin]] as const){
  const cwd=join(root,'packages',owner)
  for(const file of await readdir(join(cwd,'lib'),{withFileTypes:true}).catch(()=>[]))if(file.isFile()&&/(?:\.(?:m?js|cjs)(?:\.map)?|\.d\.ts)$/.test(file.name))await unlink(join(cwd,'lib',file.name))
  const pkg=JSON.parse(await readFile(join(cwd,'package.json'),'utf8')),external=Object.keys({...pkg.dependencies,...pkg.peerDependencies})
  await build({config:false,cwd,entry,outDir:'lib',format:['esm'],platform:'node',target:'es2024',fixedExtension:false,dts:true,sourcemap:development,clean:false,deps:{neverBundle:specifier=>external.some(name=>specifier===name||specifier.startsWith(name+'/')),alwaysBundle:[/^@jshow\//]}})
 }
 await buildBrowserClient(root,development)
}
