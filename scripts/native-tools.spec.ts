import {expect,it} from 'vitest'
import {nativeTar} from './run-mcp-build-command.ts'
it('selects system tar independently of a Git Bash or other PATH override',()=>{
  expect(nativeTar('win32',{SystemRoot:'C:\\Windows',PATH:'C:\\Git\\usr\\bin'})).toBe('C:\\Windows\\System32\\tar.exe')
  expect(nativeTar('win32',{SYSTEMROOT:'C:\\Windows',PROCESSOR_ARCHITEW6432:'AMD64'},'ia32')).toBe('C:\\Windows\\Sysnative\\tar.exe')
  expect(nativeTar('win32',{SYSTEMROOT:'C:\\Windows',PROCESSOR_ARCHITEW6432:'AMD64'},'x64')).toBe('C:\\Windows\\System32\\tar.exe')
  expect(nativeTar('darwin',{})).toBe('tar')
  expect(nativeTar('linux',{})).toBe('tar')
  expect(()=>nativeTar('win32',{})).toThrow('system directory')
})
