/** Initialize the local profile through public DSH APIs before service launch. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {lstat,readFile} from 'node:fs/promises'

/** Existing profiles must already reference the current application bundle. Never rewrite user state. */
export async function assertCurrentProfilePackage(directory:string):Promise<void>{
 const file=join(directory,'package.json')
 try{const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Profile manifest must be a regular file')}
 catch(error){if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')return;throw error}
 const value=JSON.parse(await readFile(file,'utf8'))
 if(!Array.isArray(value.dsh?.profile?.bundles)||!value.dsh.profile.bundles.includes('@jshow/app-mcp-proxy'))throw new Error('Unsupported profile bundle; update the profile to @jshow/app-mcp-proxy before starting')
}

/** @param runtime - Verified distribution. @param home - Installation-owned profile home. */
export async function ensureLocalProfile(runtime: string, home: string): Promise<void> {
  const require = createRequire(join(runtime, 'resources/dsh/package.json'))
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href) as {
    initProfile(directory: string, bundles: readonly string[]): void
    resolveProfileDir(name: string, home: string): string
  }
  const directory=boot.resolveProfileDir('mcp-proxy',home)
  await assertCurrentProfilePackage(directory)
  boot.initProfile(directory, ['@jshow/app-mcp-proxy'])
}
