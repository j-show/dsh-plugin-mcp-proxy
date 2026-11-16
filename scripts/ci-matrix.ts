/** Explicit native lanes: Intel DMG is deferred until an operator chooses another Mac runner. */
import {appendFile,mkdir,writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {appTargets} from './app-targets.ts'

interface NativeLane {os:string;build:string;target:string;rust:string}
export function nativeMatrix(macIntelRunner=''):{include:NativeLane[]}{
  const runner=macIntelRunner.trim()
  if(runner&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(runner))throw new Error('Use one valid Mac Intel runner label')
  const include:NativeLane[]=[
    {os:'windows-2025',build:'build:win',target:'win-64',rust:appTargets['win-32']!.triple+' '+appTargets['win-64']!.triple},
    {os:'macos-15',build:'build:mac:arm',target:'mac-arm',rust:appTargets['mac-arm']!.triple},
    {os:'ubuntu-22.04',build:'build:linux',target:'linux',rust:appTargets['linux']!.triple},
  ]
  if(runner)include.splice(1,0,{os:runner,build:'build:mac:intel',target:'mac-intel',rust:appTargets['mac-intel']!.triple})
  return{include}
}
async function main():Promise<void>{
  const runner=process.env.MCP_PROXY_MAC_INTEL_RUNNER??'',matrix=nativeMatrix(runner)
  if(!process.env.GITHUB_OUTPUT){process.stdout.write(JSON.stringify(matrix)+'\n');return}
  const root=resolve(import.meta.dirname,'..')
  const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim()
  const dirty=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true}).trim().length>0
  await appendFile(process.env.GITHUB_OUTPUT,'matrix='+JSON.stringify(matrix)+'\n')
  const selected=matrix.include.some(row=>row.target==='mac-intel')
  const reason=selected?'explicit Mac runner retry':'user deferred Intel DMG finalization on 2026-11-16'
  await mkdir(join(root,'.artifacts/ci'),{recursive:true})
  await writeFile(join(root,'.artifacts/ci/native-matrix.json'),JSON.stringify({revision,dirty,schedulingOnly:true,
    macIntel:{status:selected?'scheduled':'skipped',format:'dmg',reason,acceptance:selected?'requires native job results':'not verified'},
    retry:'workflow_dispatch.mac_intel_runner or build:mac:intel on another Mac'},null,2)+'\n')
  const summary='### Native validation scope\n\nWindows x86/x64, macOS ARM and Ubuntu are enabled.\n\n'
    +(selected?'Intel Mac DMG is explicitly scheduled; acceptance requires its native job results.':'Intel Mac DMG is **skipped by user decision (2026-11-16)** and remains **unverified**. DMG delivery is unchanged.')
    +'\n\nRetry on another Mac with `build:mac:intel` or set the manual workflow input `mac_intel_runner`.\n'
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,summary)
  process.stdout.write(selected?'Intel Mac DMG: explicit runner retry scheduled.\n':'Intel Mac DMG: skipped by user decision; not accepted.\n')
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().catch((error:unknown)=>{
  process.stderr.write((error instanceof Error?error.message:'Native matrix generation failed')+'\n');process.exitCode=1
})
