import {expect,it} from 'vitest'
import {readFile,readdir} from 'node:fs/promises'
it('owns exactly two delivery packages and embeds internal code without workspace dependencies',async()=>{
  for(const owner of ['mcp-proxy','dsh-plugin']){
    const root=new URL(`../packages/${owner}/`,import.meta.url)
    const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'))
    expect(Object.values(pkg.dependencies??{})).not.toContain('workspace:*')
    for(const module of await readdir(new URL('modules/',root))){
      await expect(readFile(new URL(`modules/${module}/package.json`,root))).rejects.toMatchObject({code:'ENOENT'})
    }
  }
})
