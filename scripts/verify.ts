/** Cross-platform verification entry; reports every actual command exit without PowerShell. */
import { spawn, execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'
import {verificationPlan,verificationInvocation,type VerificationStep} from './verification-plan.ts'

const root = resolve(import.meta.dirname,'..'), output = join(root,'.artifacts/ci')
const {values} = parseArgs({options:{release:{type:'boolean'},'native-only':{type:'boolean'},target:{type:'string'},plan:{type:'boolean'}}})
if(values.release&&values['native-only'])throw new Error('Choose --release or --native-only')
const mode=values.release?'release':values['native-only']?'native':'core'
const steps=verificationPlan(mode,process.platform,process.arch,values.target)
if(values.plan){process.stdout.write(JSON.stringify({mode,steps},null,2)+'\n');process.exit(0)}
await mkdir(output,{recursive:true})
const execute = promisify(execFile)
const git = async (...args: string[]) => { try { return (await execute('git',args,{cwd:root,windowsHide:true})).stdout.trim() } catch { return null } }
const report: Record<string,unknown> = { recordedAt:new Date().toISOString(),commit:await git('rev-parse','HEAD'),
  dirty:!!await git('status','--porcelain'),node:process.version,platform:process.platform,mode,status:'failed',
  plan:steps,executions:[],unverified:['Intel DMG unless explicitly selected','real model / multi-device / cross-user / history / release matrix; docs/acceptance.md'] }
async function checked(step:VerificationStep): Promise<void> {
  const {name,args}=step
  const file = join(output,name+'.log'), log = createWriteStream(file)
  const invocation = verificationInvocation(step,process.platform,process.env,pnpmInvocation([]))
  const child = spawn(invocation.command,invocation.args,{cwd:root,env:process.env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true})
  child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false})
  let launchFailed=false
  const result = await new Promise<{code:number|null;signal:string|null}>((resolve) => {
    child.once('error',()=>{launchFailed=true})
    child.once('close',(code,signal) => { log.end(() => resolve({code:launchFailed?null:code,signal})) })
  })
  ;(report.executions as unknown[]).push({command:'pnpm '+args.join(' '),launchFailed,displayWrapper:invocation.command==='xvfb-run',exitCode:result.code,signal:result.signal,log:name+'.log'})
  process.stdout.write((await readFile(file,'utf8')).split('\n').slice(-13).join('\n'))
  if (result.code !== 0 || result.signal) throw new Error(`Verification failed: ${name}; inspect ${file}`)
}
try {
  if (process.env.MCP_PROXY_PRODUCT_TESTS === '1') throw new Error('Unset MCP_PROXY_PRODUCT_TESTS before verification')
  for(const step of steps)await checked(step)
  report.status = 'passed'
} finally { await writeFile(join(output,'verification.json'),JSON.stringify(report,null,2)+'\n') }
