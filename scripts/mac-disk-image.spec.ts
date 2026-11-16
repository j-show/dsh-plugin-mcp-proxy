import {beforeEach,expect,it,vi} from 'vitest'
const mocked=vi.hoisted(()=>({execute:vi.fn((_command:string,_args:string[],_options:unknown,callback:(error:null,stdout:string,stderr:string)=>void)=>{callback(null,'','');return{}})}))
vi.mock('node:child_process',()=>({execFile:mocked.execute}))
vi.mock('node:fs/promises',()=>({cp:vi.fn(async()=>{}),mkdir:vi.fn(async()=>{}),mkdtemp:vi.fn(async()=>'/owned-image'),symlink:vi.fn(async()=>{})}))
import {createMacDiskImage} from './mac-disk-image.ts'
beforeEach(()=>{mocked.execute.mockClear()})
it('keeps normal image creation unprivileged',async()=>{
  await createMacDiskImage('/owned/app','/owned/result.dmg','/owned')
  expect(mocked.execute.mock.calls[0]?.[0]).toBe('hdiutil')
})
