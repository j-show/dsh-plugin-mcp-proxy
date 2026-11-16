import {beforeEach,expect,it,vi} from 'vitest'
const mocked=vi.hoisted(()=>({execute:vi.fn((_command:string,_args:string[],_options:unknown,callback:(error:null,stdout:string,stderr:string)=>void)=>{callback(null,'','');return{}})}))
vi.mock('node:child_process',()=>({execFile:mocked.execute}))
vi.mock('node:fs/promises',()=>({cp:vi.fn(async()=>{}),mkdir:vi.fn(async()=>{}),mkdtemp:vi.fn(async()=>'/owned-image'),symlink:vi.fn(async()=>{})}))
import {createMacDiskImage} from './mac-disk-image.ts'
beforeEach(()=>{mocked.execute.mockClear()})
it('keeps normal image creation unprivileged',async()=>{
  await createMacDiskImage('/owned/app','/owned/result.dmg','/owned',false)
  expect(mocked.execute.mock.calls[0]?.[0]).toBe('hdiutil')
})
it('elevates only the absolute native image tool through explicit noninteractive opt-in',async()=>{
  await createMacDiskImage('/owned/app','/owned/result.dmg','/owned',true)
  const call=mocked.execute.mock.calls[0]!
  expect(call[0]).toBe('/usr/bin/sudo')
  expect(call[1].slice(0,3)).toEqual(['-n','/usr/bin/hdiutil','create'])
  expect(call[1]).toContain('/owned/result.dmg')
})
