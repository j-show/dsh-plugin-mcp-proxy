import {expect,it} from 'vitest'
import {verificationPlan, verificationInvocation} from './verification-plan.ts'

it('keeps core verification independent of Cargo, installers and desktop availability',()=>{
  const plan=verificationPlan('core','linux','x64')
  expect(plan.map(step=>step.args)).toEqual([
    ['dev:doctor'],['dev:init'],['build:shared'],['typecheck'],['test'],['dev:check'],
  ])
})
it('runs the native default test suite and both Windows architecture acceptances',()=>{
  const plan=verificationPlan('native','win32','x64')
  expect(plan.some(step=>step.args[0]==='test')).toBe(true)
  expect(plan.filter(step=>step.args[0]==='test:product').map(step=>step.args.at(-1))).toEqual(['win-64','win-32'])
  expect(plan.filter(step=>step.args[0]==='test:installer').map(step=>step.args.at(-1))).toEqual(['win-64','win-32'])
  expect(plan.filter(step=>step.args[0]==='test:browser').map(step=>step.args.at(-1))).toEqual(['--preflight','win-64','win-32'])
})
it('keeps deferred Intel out of automatic Mac acceptance but permits explicit retries',()=>{
  const plan=verificationPlan('release','darwin','arm64')
  expect(plan.some(step=>step.args[0]==='build:mac:arm')).toBe(true)
  expect(plan.some(step=>step.args[0]==='build:mac')).toBe(false)
  expect(()=>verificationPlan('native','darwin','x64')).toThrow('explicit --target mac-intel')
  const retry=verificationPlan('native','darwin','x64','mac-intel')
  expect(retry.some(step=>step.args[0]==='test:installer'&&step.args.at(-1)==='mac-intel')).toBe(true)
  expect(()=>verificationPlan('native','linux','x64','win-64')).toThrow('build host')
  expect(()=>verificationPlan('core','linux','x64','linux')).toThrow('--target requires')
})
it('uses Xvfb only for Linux artifact execution without a display',()=>{
  const step={name:'product-linux',args:['test:product','--target','linux'],display:true}
  expect(verificationInvocation(step,'linux',{}, {command:'node',args:['pnpm.cjs']})).toEqual({command:'xvfb-run',args:['-a','node','pnpm.cjs','test:product','--target','linux']})
  expect(verificationInvocation(step,'linux',{DISPLAY:':0'}, {command:'node',args:['pnpm.cjs']}).command).toBe('node')
  expect(verificationInvocation({...step,display:false},'linux',{}, {command:'node',args:['pnpm.cjs']}).command).toBe('node')
})
