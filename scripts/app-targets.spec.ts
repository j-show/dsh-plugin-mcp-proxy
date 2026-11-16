import { expect, it } from 'vitest'
import { appBuildPlan, bundleKinds, frontendDirectory } from './app-targets.ts'
import {join,resolve} from 'node:path'
import { targetRuntimeDownload } from './mcp-build-runtime.ts'

it('plans both Windows and Mac architectures while rejecting cross-system builds and unknown targets', () => {
  expect(appBuildPlan('win', 'win32').map(row => row.arch)).toEqual(['ia32', 'x64'])
  expect(appBuildPlan('mac', 'darwin').map(row => row.arch)).toEqual(['x64', 'arm64'])
  // DMGs are created directly from this retained bundle, avoiding Finder/mount layout scripts.
  for(const target of appBuildPlan('mac','darwin'))expect(bundleKinds(target)).toEqual(['app'])
  expect(appBuildPlan('linux', 'linux')[0]?.triple).toBe('x86_64-unknown-linux-gnu')
  expect(() => appBuildPlan('mac', 'win32')).toThrow('darwin build host')
  expect(() => appBuildPlan('all', 'win32')).toThrow('Unknown')
  for (const [host, group] of [['win32','win'],['darwin','mac'],['linux','linux']] as const) {
    for (const target of appBuildPlan(group, host)) expect(targetRuntimeDownload(target.platform, target.arch).version).toBe('22.23.5')
  }
})
it('embeds frontend assets through a relative directory rather than an absolute drive-letter URL',()=>{
  const root=resolve('fixture')
  const directory=frontendDirectory(join(root,'packages/mcp-proxy/src-tauri'),join(root,'.artifacts/shared/desktop'))
  expect(directory).toBe('../../../.artifacts/shared/desktop')
  expect(()=>new URL(directory)).toThrow()
})
