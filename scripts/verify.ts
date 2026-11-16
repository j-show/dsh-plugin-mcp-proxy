/** Cross-platform verification entry; reports every actual command exit without PowerShell. */
import { spawn, execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'
import {appBuildPlan} from './app-targets.ts'

const root = resolve(import.meta.dirname,'..'), output = join(root,'.artifacts/ci')
const {values} = parseArgs({options:{release:{type:'boolean'}}})
await mkdir(output,{recursive:true})
const execute = promisify(execFile)
const git = async (...args: string[]) => { try { return (await execute('git',args,{cwd:root,windowsHide:true})).stdout.trim() } catch { return null } }
const report: Record<string,unknown> = { recordedAt:new Date().toISOString(),commit:await git('rev-parse','HEAD'),
  dirty:!!await git('status','--porcelain'),node:process.version,mode:values.release?'release':'core',executions:[] }
async function checked(name: string, args: string[]): Promise<void> {
  const file = join(output,name+'.log'), log = createWriteStream(file)
  const invocation = pnpmInvocation(args)
  const child = spawn(invocation.command,invocation.args,{cwd:root,env:process.env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true})
  child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false})
  const result = await new Promise<{code:number|null;signal:string|null}>((resolve,reject) => {
    child.once('error',reject); child.once('close',(code,signal) => { log.end(() => resolve({code,signal})) })
  })
  ;(report.executions as unknown[]).push({command:'pnpm '+args.join(' '),exitCode:result.code,signal:result.signal,log:name+'.log'})
  process.stdout.write((await readFile(file,'utf8')).split('\n').slice(-13).join('\n'))
  if (result.code !== 0 || result.signal) throw new Error(`Verification failed: ${name}; inspect ${file}`)
}
try {
  if (process.env.MCP_PROXY_PRODUCT_TESTS === '1') throw new Error('Unset MCP_PROXY_PRODUCT_TESTS before verification')
  await checked('doctor',['dev:doctor','--packaging'])
  await checked('development-init',['dev:init'])
  await checked('shared',['build:shared'])
  await checked('typecheck',['typecheck'])
  await checked('test',['test'])
  await checked('rust',['test:rust'])
  await checked('development-check',['dev:check'])
  if (values.release) {
    const command = process.platform === 'win32' ? 'build:win' : process.platform === 'darwin' ? 'build:mac' : 'build:linux'
    await checked('application',[command])
    await checked('plugin',['build:mcp-plugin','--skip-build'])
    const target=appBuildPlan('host',process.platform)[0]!.id
    await checked('product',['test:product','--target',target])
    await checked('installer',['test:installer','--target',target])
    if (process.platform === 'win32') {
      await checked('product-win32',['test:product','--target','win-32'])
      await checked('installer-win32',['test:installer','--target','win-32'])
      await checked('browser-desktop',['test:browser','--target','win-64'])
      await checked('browser-win32',['test:browser','--target','win-32'])
    }
  }
  report.status = 'passed'
} finally { await writeFile(join(output,'verification.json'),JSON.stringify(report,null,2)+'\n') }
