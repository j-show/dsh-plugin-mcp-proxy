/** Exercise packaged payloads; Windows install/uninstall refuses pre-existing product owners. */
import {execFile,spawn} from 'node:child_process'
import {promisify,parseArgs} from 'node:util'
import {once} from 'node:events'
import {createHash} from 'node:crypto'
import {mkdir,mkdtemp,readFile,readdir,lstat,rm,unlink,rmdir,writeFile,copyFile} from 'node:fs/promises'
import {join,resolve,relative} from 'node:path'
import {readProductBuild} from './product-build.ts'
import {verifyDesktopRuntime} from './runtime-inventory.ts'
import {compileDesktopProbe,nativeProbe} from './browser-native.ts'
import {isolatedEnvironment} from './browser-e2e-environment.ts'
import {eventually} from './browser-cdp.ts'
import {withProductRunLock} from './product-service.ts'

const root=resolve(import.meta.dirname,'..'),execute=promisify(execFile)
const {values}=parseArgs({options:{target:{type:'string'}}})
const build=await readProductBuild(root,values.target)
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
interface InstallInfo {installations:Array<{scope:string;view:string;location:string;uninstall:string}>;run:boolean;appId:boolean;uriDigest:string}
await mkdir(join(root,'.artifacts/ci'),{recursive:true})
await mkdir(join(root,'.artifacts/installer-tests'),{recursive:true})
await withProductRunLock(async()=>{
  const state=await mkdtemp(join(root,'.artifacts/installer-tests/run-'))
  const report:Record<string,unknown>={target:build.target,status:'failed',cleanup:false}
  const env={...isolatedEnvironment(join(state,'home'),join(state,'data')),XDG_DATA_HOME:join(state,'data'),
    XDG_CACHE_HOME:join(state,'cache'),APPDATA:join(state,'roaming'),NODE_OPTIONS:undefined,NODE_PATH:undefined,NODE_EXTRA_CA_CERTS:undefined}
  await mkdir(join(state,'workspace'))
  const help=async(executable:string)=>{
    const result=await execute(executable,['--help'],{cwd:join(state,'workspace'),env,windowsHide:true,timeout:90000,maxBuffer:1048576})
    if(!result.stdout.includes('--config')||!result.stdout.includes('--associate'))throw new Error('Installed application CLI unavailable')
  }
  const invokeInstaller=async(file:string,args:string[])=>{
    const child=spawn(file,args,{cwd:state,env,stdio:'ignore',windowsHide:true,windowsVerbatimArguments:true,argv0:'"'+file+'"'})
    const timer=setTimeout(()=>{child.kill()},180000)
    try{const[code,signal]=await once(child,'exit');if(code!==0||signal)throw new Error('Owned installer command failed')}
    finally{clearTimeout(timer)}
  }
  try{
    if(process.platform==='win32'){
      const helper=await compileDesktopProbe(state);await nativeProbe(helper,'protect-state',state)
      const before=await nativeProbe<InstallInfo>(helper,'installer-info')
      if(before.installations.length||before.run||before.appId||before.uriDigest!==digest(Buffer.alloc(0)).toUpperCase())throw new Error('Installer test requires no existing mcp-proxy installation/integration; unknown owners are preserved')
      const installed=join(state,'installed'),executable=join(installed,'mcp-proxy.exe'),uninstaller=join(installed,'uninstall.exe')
      const unquote=(value:string)=>value.replace(/^"|"$/g,'')
      let installedOwner=false
      try{
        await invokeInstaller(build.installer,['/S','/NS','/D='+installed])
        const info=await nativeProbe<InstallInfo>(helper,'installer-info')
        installedOwner=info.installations.length>0&&info.installations.every(row=>resolve(unquote(row.location)).toLowerCase()===resolve(installed).toLowerCase()
          &&resolve(unquote(row.uninstall)).toLowerCase()===resolve(uninstaller).toLowerCase())
        if(!installedOwner)throw new Error('Installer ownership receipt does not match the test directory')
        if(digest(await readFile(executable))!==build.executableSha256){
          await copyFile(executable,join(state,'observed-mcp-proxy.exe'));report.diagnosticState=relative(root,state)
          throw new Error('Installer application differs from the bound build')
        }
        await verifyDesktopRuntime(installed);await help(executable);await verifyDesktopRuntime(installed)
        await execute(executable,['--install'],{cwd:join(state,'workspace'),env,windowsHide:true,timeout:90000,maxBuffer:1048576})
        if((await nativeProbe<InstallInfo>(helper,'installer-info')).uriDigest===before.uriDigest)throw new Error('Installed application did not register its URI')
        report.uri='registered by installed application; removal must be performed by the ordinary uninstaller'
        report.payload='installed executable and runtime matched the recorded build; CLI passed'
      }finally{
        const info=await nativeProbe<InstallInfo>(helper,'installer-info')
        if(!installedOwner&&info.installations.length)throw new Error('Unverified installer ownership; retaining state without uninstalling')
        if(installedOwner){
          const hash=digest(await readFile(uninstaller))
          await invokeInstaller(uninstaller,['/S','_?='+installed])
          await eventually(async()=>!(await nativeProbe<InstallInfo>(helper,'installer-info')).installations.length,'installer registry removal')
          let remaining:string[]=[];try{remaining=await readdir(installed)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
          if(remaining.length===1&&remaining[0]==='uninstall.exe'&&digest(await readFile(uninstaller))===hash){await unlink(uninstaller);await rmdir(installed)}
          else if(remaining.length)throw new Error('Installer left unexpected files; retaining state')
        }
        const after=await nativeProbe<InstallInfo>(helper,'installer-info')
        if(after.uriDigest!==before.uriDigest||after.run!==before.run||after.appId!==before.appId)throw new Error('Installer changed pre-existing integration state')
      }
      report.scope='real current-user NSIS install, installed CLI/URI registration and ordinary owned uninstall; integrations restored'
    }else if(process.platform==='darwin'){
      const mount=join(state,'mount');await mkdir(mount)
      let mounted=false
      try{
        await execute('hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,build.installer],{timeout:90000});mounted=true
        const apps=(await readdir(mount)).filter(name=>name==='mcp-proxy.app')
        if(apps.length!==1)throw new Error('DMG lacks its application')
        const contents=join(mount,apps[0]!,'Contents'),executable=join(contents,'MacOS/mcp-proxy'),distribution=join(contents,'Resources')
        if(digest(await readFile(executable))!==build.executableSha256)throw new Error('DMG executable differs from the bound build')
        await verifyDesktopRuntime(distribution);await help(executable);await verifyDesktopRuntime(distribution)
      }finally{if(mounted){
        try{await execute('hdiutil',['detach',mount],{timeout:15000})}
        catch{await execute('hdiutil',['detach','-force',mount],{timeout:30000})}
      }}
      report.scope='read-only mounted DMG application CLI; no LaunchServices or installation changes'
    }else if(process.platform==='linux'){
      const extracted=join(state,'extract');await mkdir(extracted)
      await execute('dpkg-deb',['-x',build.installer,extracted],{timeout:90000})
      const executable=join(extracted,'usr/bin/mcp-proxy'),distribution=join(extracted,'usr/lib/mcp-proxy')
      if(digest(await readFile(executable))!==build.executableSha256)throw new Error('Debian executable differs from the bound build')
      await verifyDesktopRuntime(distribution)
      if(!((await lstat(join(distribution,'resources/dsh/runtime/node'))).mode&0o111))throw new Error('Debian Node runtime is not executable')
      await help(executable)
      report.scope='extracted Debian application CLI and runtime; no system package database changes'
    }else throw new Error('Unsupported installer test platform')
    const parent=join(root,'.artifacts/installer-tests'),child=relative(parent,state)
    if(!child.startsWith('run-')||child.includes('/')||child.includes('\\')||(await lstat(state)).isSymbolicLink())throw new Error('Installer test directory ownership changed')
    await rm(state,{recursive:true,force:true})
    report.status='passed';report.cleanup=true
  }catch(error){report.error=error instanceof Error?error.message:'Installer verification failed';throw error}
  finally{await writeFile(join(root,`.artifacts/ci/installer-${build.target}.json`),JSON.stringify(report,null,2)+'\n')}
})
