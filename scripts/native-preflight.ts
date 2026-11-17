/** Native dependency discovery without host integration changes. Linux xdo compiles a private probe but never runs it. */
import {execFile} from 'node:child_process'
import {access,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {promisify} from 'node:util'
import {nativeTar} from './run-mcp-build-command.ts'

export interface Prerequisite {name:string;ready:boolean;hint:string;observation?:string;errorCode?:string|number}
type Run=(file:string,args:readonly string[])=>Promise<string>
const execute=promisify(execFile)
async function run(file:string,args:readonly string[]):Promise<string>{
  return (await execute(file,[...args],{timeout:15000,windowsHide:true,maxBuffer:1048576})).stdout.trim()
}
async function exists(file:string):Promise<boolean>{try{await access(file);return true}catch{return false}}
async function xdoLink(invoke:Run):Promise<boolean>{
  const directory=await mkdtemp(join(tmpdir(),'mcp-native-check-'))
  try{
    const source=join(directory,'xdo.c')
    await writeFile(source,'#include <xdo.h>\nint main(void) { xdo_t *x = xdo_new(0); xdo_free(x); return 0; }\n',{mode:0o600})
    await invoke('cc',[source,'-lxdo','-o',join(directory,'xdo-probe')])
    return true
  }catch{return false}
  finally{await rm(directory,{recursive:true,force:true})}
}
async function windowsSdk(env:NodeJS.ProcessEnv):Promise<boolean>{
  const base=env['ProgramFiles(x86)']??env.ProgramFiles
  if(!base)return false
  const root=join(base,'Windows Kits/10')
  try{
    for(const version of await readdir(join(root,'Lib'))){
      if(!/^10\.[0-9.]+$/.test(version))continue
      const files=['Include/'+version+'/um/Windows.h',...['x86','x64'].flatMap(arch=>[
        `Lib/${version}/um/${arch}/kernel32.lib`,`Lib/${version}/ucrt/${arch}/ucrt.lib`])]
      if((await Promise.all(files.map(file=>exists(join(root,file))))).every(Boolean))return true
    }
  }catch{/* Missing/inaccessible SDK is a failed check, never ready. */}
  return false
}
export async function nativePrerequisites(platform:NodeJS.Platform,env:NodeJS.ProcessEnv=process.env,invoke:Run=run):Promise<Prerequisite[]>{
  const checks:Prerequisite[]=[]
  const command=async(name:string,file:string,args:readonly string[],hint:string,requireOutput=true):Promise<void>=>{
    let ready=false,observation='execution-failed',errorCode:string|number|undefined
    try{
      const output=await invoke(file,args)
      observation=output.trim()?'stdout-present':'empty-stdout'
      ready=!requireOutput||observation==='stdout-present'
    }catch(error:unknown){
      if(error&&typeof error==='object'&&'code' in error){
        const code=error.code
        if(typeof code==='number'||typeof code==='string'&&/^[A-Z0-9_]{1,40}$/.test(code))errorCode=code
      }
    }
    checks.push({name,ready,hint,observation,...(errorCode===undefined?{}:{errorCode})})
  }
  await command('Cargo','cargo',['--version'],'Install rustup and the repository rust-toolchain.toml toolchain.')
  await command('Rust compiler','rustc',['--version'],'Install the pinned Rust toolchain with rustup.')
  await command('rustup','rustup',['--version'],'Install rustup; native builds prepare target libraries through it.')
  let tar:string|undefined
  try{tar=nativeTar(platform,env)}catch{/* Missing system root is a prerequisite failure. */}
  if(tar)await command('tar',tar,['--version'],'Install system tar; Windows must use System32 tar.')
  else checks.push({name:'tar',ready:false,hint:'Restore the Windows SystemRoot/WINDIR environment and system tar.'})
  if(platform==='win32'){
    const programFiles=env['ProgramFiles(x86)']??env.ProgramFiles??''
    await command('MSVC x86/x64',join(programFiles,'Microsoft Visual Studio/Installer/vswhere.exe'),
      ['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],
      'Install Visual Studio Build Tools: Desktop development with C++, MSVC x86/x64 tools.')
    checks.push({name:'Windows SDK x86/x64',ready:await windowsSdk(env),hint:'Install Windows 10/11 SDK (headers, UM and UCRT libraries for x86/x64) in Windows Kits/10.'})
    const compiler=['Framework64','Framework'].map(dir=>join(env.WINDIR??env.SystemRoot??'',`Microsoft.NET/${dir}/v4.0.30319/csc.exe`))
    checks.push({name:'.NET Framework compiler',ready:(await Promise.all(compiler.map(exists))).some(Boolean),hint:'Enable .NET Framework 4.x csc.exe for the native URI bridge and UI automation helper.'})
    const suffix='SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    let webview=false
    for(const hive of ['HKCU','HKLM'])for(const view of ['32','64']){
      try{const value=await invoke('reg.exe',['query',hive+'\\'+suffix,'/v','pv','/reg:'+view]);
        if(/\bpv\s+REG_SZ\s+(?!0\.0\.0\.0\b)\d+\.\d+\.\d+\.\d+\b/i.test(value))webview=true
      }catch{/* Missing registration is reported below. */}
    }
    checks.push({name:'WebView2 Runtime',ready:webview,hint:'Install Microsoft Edge WebView2 Evergreen Runtime; NSIS bootstrap is not a development GUI prerequisite check.'})
  }else if(platform==='darwin'){
    await command('Xcode tools','xcrun',['--find','clang'],'Run xcode-select --install; complete Xcode licensing/setup if required.')
    await command('macOS SDK','xcrun',['--show-sdk-path'],'Select an installed Xcode/Command Line Tools SDK.')
    await command('DMG tools','hdiutil',['help'],'Use macOS system hdiutil; Intel DMG remains deferred unless explicitly selected.',false)
  }else if(platform==='linux'){
    await command('C compiler','cc',['--version'],'Install build-essential and pkg-config.')
    for(const [name,pkg] of [['WebKitGTK','webkit2gtk-4.1'],['GTK','gtk+-3.0'],['AppIndicator','ayatana-appindicator3-0.1'],['OpenSSL','openssl'],['librsvg','librsvg-2.0']]){
      await command(name!,'pkg-config',['--modversion',pkg!],'Install the Ubuntu native dependency list in docs/development.md.')
    }
    checks.push({name:'X11 xdo',ready:await xdoLink(invoke),hint:'Install libxdo-dev; cc must link xdo.h and -lxdo. The probe is compiled in a private temporary directory, never executed.'})
    await command('Debian packaging','dpkg-deb',['--version'],'Install dpkg-dev for Debian packaging and extraction.')
    await command('patchelf','patchelf',['--version'],'Install patchelf.')
    if(!env.DISPLAY&&!env.WAYLAND_DISPLAY)await command('Xvfb','xvfb-run',['--help'],'Install xvfb and xauth for headless artifact execution.')
  }else throw new Error('Native development requires Windows, macOS or Linux')
  return checks
}
