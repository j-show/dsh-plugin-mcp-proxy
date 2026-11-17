/** Initialize the local profile through public DSH APIs before service launch. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {lstat,readFile,writeFile} from 'node:fs/promises'

/** Update only the known legacy bundle reference; identities and custom settings remain untouched. */
export async function migrateLocalProfilePackage(directory:string):Promise<void>{
  const file=join(directory,'package.json')
  try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Profile manifest must be a regular file')}
  catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return;throw error}
  const value=JSON.parse(await readFile(file,'utf8')),legacy='@j-show/mcp-proxy-runtime',name='@jshow/app-mcp-proxy'
  const bundles=value.dsh?.profile?.bundles
  if(!Array.isArray(bundles)||!bundles.includes(legacy))return
  if(bundles.includes(name)||value.dependencies?.[name])throw new Error('Conflicting runtime bundle identities')
  const {[legacy]:version,...dependencies}=value.dependencies??{}
  await writeFile(file,JSON.stringify({...value,dependencies:{...dependencies,...(version?{[name]:version}:{})},
    dsh:{...value.dsh,profile:{...value.dsh.profile,bundles:bundles.map((entry:string)=>entry===legacy?name:entry)}}},null,2)+'\n')
}

/** @param runtime - Verified distribution. @param home - Installation-owned profile home. */
export async function ensureLocalProfile(runtime: string, home: string): Promise<void> {
  const require = createRequire(join(runtime, 'resources/dsh/package.json'))
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href) as {
    initProfile(directory: string, bundles: readonly string[]): void
    resolveProfileDir(name: string, home: string): string
  }
  const directory=boot.resolveProfileDir('mcp-proxy',home)
  await migrateLocalProfilePackage(directory)
  boot.initProfile(directory, ['@jshow/app-mcp-proxy'])
}
