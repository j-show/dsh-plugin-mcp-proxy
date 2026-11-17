/** One explicit command plan for local verification and CI. No acceptance is inferred from skips. */
import {appBuildPlan} from './app-targets.ts'

export interface VerificationStep {name:string;args:string[];display?:boolean}
export type VerificationMode='core'|'native'|'release'
export function verificationPlan(mode:VerificationMode,platform:NodeJS.Platform,arch:string,target?:string):VerificationStep[]{
  if(target&&mode==='core')throw new Error('--target requires --release or --native-only')
  const core:VerificationStep[]=[
    {name:'doctor',args:['dev:doctor']},{name:'development-init',args:['dev:init']},
    {name:'shared',args:['build:shared']},{name:'typecheck',args:['typecheck']},
    {name:'test',args:['test']},{name:'development-check',args:['dev:check']},
  ]
  if(mode==='core')return core
  if(!target&&platform==='darwin'&&arch!=='arm64')throw new Error('Intel DMG is deferred; retry with explicit --target mac-intel on another Mac')
  const group=target??(platform==='win32'?'win':platform==='darwin'?'mac-arm':'linux')
  const targets=appBuildPlan(group,platform)
  if(group==='mac')throw new Error('Select --target mac-arm or explicit --target mac-intel')
  const build=group==='win'?'build:win':group==='linux'?'build:linux':`build:${group.replace('-',':')}`
  const native:VerificationStep[]=[{name:'doctor-native',args:['dev:doctor','--packaging']},
    ...(mode==='native'?[{name:'test-native-host',args:['test']}]:[]),
    {name:'rust',args:['test:rust']},{name:'application',args:[build]},
    {name:'plugin',args:['build:mcp-plugin','--skip-build']},
    ...[...targets].reverse().flatMap(t=>[
      {name:'installer-'+t.id,args:['test:installer','--target',t.id],display:true},
      {name:'product-'+t.id,args:['test:product','--target',t.id],display:true},
    ]),
    ...(platform==='win32'?[{name:'browser-preflight',args:['test:browser','--preflight']},
      ...[...targets].reverse().map(t=>({name:'browser-'+t.id,args:['test:browser','--target',t.id]}))]:[]),
  ]
  return [...(mode==='release'?core:[]),...native]
}
export function verificationInvocation(step:VerificationStep,platform:NodeJS.Platform,env:NodeJS.ProcessEnv,
  pnpm:{command:string;args:string[]}):{command:string;args:string[]}{
  const args=[...pnpm.args,...step.args]
  return platform==='linux'&&step.display&&!env.DISPLAY&&!env.WAYLAND_DISPLAY
    ?{command:'xvfb-run',args:['-a',pnpm.command,...args]}:{command:pnpm.command,args}
}
