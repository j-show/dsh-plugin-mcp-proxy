import { expect, it } from 'vitest'
import { appBuildPlan } from './app-targets.ts'
import { targetRuntimeDownload } from './mcp-build-runtime.ts'

it('plans both Windows and Mac architectures while rejecting cross-system builds and unknown targets', () => {
  expect(appBuildPlan('win', 'win32').map(row => row.arch)).toEqual(['ia32', 'x64'])
  expect(appBuildPlan('mac', 'darwin').map(row => row.arch)).toEqual(['x64', 'arm64'])
  expect(appBuildPlan('linux', 'linux')[0]?.triple).toBe('x86_64-unknown-linux-gnu')
  expect(() => appBuildPlan('mac', 'win32')).toThrow('darwin build host')
  expect(() => appBuildPlan('all', 'win32')).toThrow('Unknown')
  for (const [host, group] of [['win32','win'],['darwin','mac'],['linux','linux']] as const) {
    for (const target of appBuildPlan(group, host)) expect(targetRuntimeDownload(target.platform, target.arch).version).toBe('22.23.5')
  }
})
