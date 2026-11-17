import {expect,it,onTestFinished} from 'vitest'
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'

it.each(['exit','spawn'] as const)('stops verification on %s failure and records it without claiming success',async failure=>{
  const root=await mkdtemp(join(tmpdir(),'verification-cli-'))
  onTestFinished(()=>rm(root,{recursive:true,force:true}))
  await mkdir(join(root,'scripts'))
  for(const file of ['verify.ts','verification-plan.ts','app-targets.ts','run-mcp-build-command.ts']){
    await copyFile(new URL(file,import.meta.url),join(root,'scripts',file))
  }
  await writeFile(join(root,'package.json'),'{"type":"module"}')
  const fake=join(root,'pnpm.mjs'),calls=join(root,'calls.jsonl')
  await writeFile(fake,`import {appendFileSync} from 'node:fs';appendFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='typecheck')process.exit(7);`)
  const require=createRequire(import.meta.url)
  const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['npm_execpath','calls'].includes(key.toLowerCase())))
  const entry=failure==='exit'?fake:join(root,'missing-pnpm')
  const result=await promisify(execFile)(process.execPath,['--import',pathToFileURL(require.resolve('tsx/esm')).href,join(root,'scripts/verify.ts')],
    {cwd:root,env:{...environment,npm_execpath:entry,CALLS:calls},timeout:30000}).catch((error:unknown)=>error)
  expect(result,await readFile(join(root,'logs/verify/doctor.log'),'utf8')).toBeInstanceOf(Error)
  const report=JSON.parse(await readFile(join(root,'.artifacts/ci/verification.json'),'utf8'))
  expect(report.status).toBe('failed')
  expect(report.executions[0].log).toBe('logs/verify/doctor.log')
  if(failure==='exit'){
    expect((result as Error).message).toContain('Verification failed: typecheck')
    expect((await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line))).toEqual([
      ['dev:doctor'],['dev:init'],['build:shared'],['typecheck'],
    ])
    expect(report.executions.at(-1).exitCode).toBe(7)
  }else{
    expect(report.executions).toHaveLength(1)
    expect(report.executions[0]).toMatchObject({command:'pnpm dev:doctor',exitCode:null,launchFailed:true})
  }
})
