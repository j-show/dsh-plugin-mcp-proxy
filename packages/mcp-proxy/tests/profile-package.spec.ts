import {expect,it,onTestFinished} from 'vitest'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {migrateLocalProfilePackage} from '../src/ensure-profile.ts'
it('migrates only the legacy bundle metadata and preserves identity/custom settings on repeat',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'profile-package-'))
  onTestFinished(()=>rm(directory,{recursive:true,force:true}))
  await writeFile(join(directory,'identity.yaml'),'private-marker')
  await writeFile(join(directory,'package.json'),JSON.stringify({custom:'keep',dependencies:{'@j-show/mcp-proxy-runtime':'0.1.0',other:'1'},dsh:{profile:{bundles:['other','@j-show/mcp-proxy-runtime']}}}))
  await migrateLocalProfilePackage(directory)
  await migrateLocalProfilePackage(directory)
  const value=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
  expect(value.custom).toBe('keep')
  expect(value.dependencies).toEqual({other:'1','@jshow/app-mcp-proxy':'0.1.0'})
  expect(value.dsh.profile.bundles).toEqual(['other','@jshow/app-mcp-proxy'])
  expect(await readFile(join(directory,'identity.yaml'),'utf8')).toBe('private-marker')
})
it('refuses mixed old/new identities before changing the profile',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'profile-conflict-'))
  onTestFinished(()=>rm(directory,{recursive:true,force:true}))
  const file=join(directory,'package.json'),before=JSON.stringify({dependencies:{'@jshow/app-mcp-proxy':'custom'},dsh:{profile:{bundles:['@j-show/mcp-proxy-runtime']}}})
  await writeFile(file,before)
  await expect(migrateLocalProfilePackage(directory)).rejects.toThrow('Conflicting')
  expect(await readFile(file,'utf8')).toBe(before)
})
