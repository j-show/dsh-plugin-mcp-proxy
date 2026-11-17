import {expect,it} from 'vitest'
import {nativePrerequisites} from './native-preflight.ts'

it('reports missing native dependencies per host instead of declaring Cargo sufficient',async()=>{
  const run=async()=>''
  for(const [platform,wanted] of [['win32','MSVC'],['linux','WebKitGTK'],['darwin','Xcode']] as const){
    const checks=await nativePrerequisites(platform,{},run)
    expect(checks.some(check=>!check.ready&&check.name.includes(wanted))).toBe(true)
    expect(checks.every(check=>typeof check.ready==='boolean'&&check.hint.length>0)).toBe(true)
  }
})
it('requires Linux display support only when no display is configured',async()=>{
  const run=async(command:string,args:readonly string[])=>{
    if(command==='xvfb-run')throw new Error('missing')
    if(command==='pkg-config')return '2.0'
    return args.includes('--version')?'version':''
  }
  expect((await nativePrerequisites('linux',{},run)).find(check=>check.name==='Xvfb')?.ready).toBe(false)
  expect((await nativePrerequisites('linux',{DISPLAY:':0'},run)).some(check=>check.name==='Xvfb')).toBe(false)
})
it('checks Ubuntu xdo with the compiler rather than requiring a nonexistent libxdo.pc',async()=>{
  const calls:Array<{command:string;args:readonly string[]}>=[]
  const run=async(command:string,args:readonly string[])=>{
    calls.push({command,args})
    if(command==='pkg-config'&&args.includes('libxdo'))throw new Error('No libxdo.pc on Ubuntu')
    return 'available'
  }
  const checks=await nativePrerequisites('linux',{DISPLAY:':0'},run)
  expect(checks.find(check=>check.name==='X11 xdo')?.ready).toBe(true)
  expect(calls.some(call=>call.command==='cc'&&call.args.includes('-lxdo'))).toBe(true)
})
it('accepts a successful hdiutil help command without stdout but preserves execution failures',async()=>{
  const success=async(command:string)=>command==='hdiutil'?'':'available'
  expect((await nativePrerequisites('darwin',{},success)).find(check=>check.name==='DMG tools')?.ready).toBe(true)
  const failure=async(command:string)=>{if(command==='hdiutil')throw new Error('failed');return 'available'}
  expect((await nativePrerequisites('darwin',{},failure)).find(check=>check.name==='DMG tools')?.ready).toBe(false)
})
