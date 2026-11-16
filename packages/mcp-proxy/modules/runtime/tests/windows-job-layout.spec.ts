import { expect, it } from 'vitest'
import { holdCurrentProcessJob } from '../src/windows-job.ts'
import type { Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'

it.each([['ia32',112],['x64',144]] as const)('uses the %s Job structure for arming and disarming', async (arch, expected) => {
  const sizes: number[] = [], flags: number[] = []
  const api = {
    createJobObjectW: () => 1,
    setInformationJobObject: (_job:unknown,_kind:number,buffer:Buffer,size:number) => { sizes.push(size); flags.push(buffer.readUInt32LE(16)); return 1 },
    assignProcessToJobObject: () => 1,
    queryInformationJobObject: (_job:unknown,_kind:number,buffer:Buffer) => { buffer.writeUInt32LE(1,40); return 1 },
    closeHandle: () => 1,
  } as unknown as Win32ProcessBindings
  const job = holdCurrentProcessJob(api,2,arch)
  await job.release({ timeoutMs:1000,pollIntervalMs:1 })
  expect(sizes).toEqual([expected,expected])
  expect(flags).toEqual([0x2000,0])
})
