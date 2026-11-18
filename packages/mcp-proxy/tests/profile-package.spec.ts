import {expect,it,onTestFinished} from 'vitest'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {assertCurrentProfilePackage} from '../src/ensure-profile.ts'
it('preserves an already-current profile and identity on repeat',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'profile-package-'))
  onTestFinished(()=>rm(directory,{recursive:true,force:true}))
  await writeFile(join(directory,'identity.yaml'),'private-marker')
  await writeFile(join(directory,'package.json'),JSON.stringify({custom:'keep',dependencies:{'@jshow/app-mcp-proxy':'0.1.0',other:'1'},dsh:{profile:{bundles:['other','@jshow/app-mcp-proxy']}}}))
  await assertCurrentProfilePackage(directory)
  await assertCurrentProfilePackage(directory)
  const value=JSON.parse(await readFile(join(directory,'package.json'),'utf8'))
  expect(value.custom).toBe('keep')
  expect(value.dependencies).toEqual({other:'1','@jshow/app-mcp-proxy':'0.1.0'})
  expect(value.dsh.profile.bundles).toEqual(['other','@jshow/app-mcp-proxy'])
  expect(await readFile(join(directory,'identity.yaml'),'utf8')).toBe('private-marker')
})
it('refuses unsupported bundle identities without rewriting the profile',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'profile-conflict-'))
  onTestFinished(()=>rm(directory,{recursive:true,force:true}))
  const file=join(directory,'package.json'),before=JSON.stringify({dependencies:{'@jshow/app-mcp-proxy':'custom'},dsh:{profile:{bundles:['@fixture/retired-runtime']}}})
  await writeFile(file,before)
  await expect(assertCurrentProfilePackage(directory)).rejects.toThrow('Unsupported profile bundle')
  expect(await readFile(file,'utf8')).toBe(before)
})
