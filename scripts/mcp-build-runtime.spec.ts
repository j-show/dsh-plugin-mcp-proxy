import { expect, it } from 'vitest'
import { mcpBuildRuntimeDownload, mcpBuildEnvironment, targetRuntimeDownload } from './mcp-build-runtime.ts'

it('selects a checksum-pinned Node 22 runtime for a host running another Node major', () => {
  const download = mcpBuildRuntimeDownload('win32', 'v24.15.0', 'x64')
  expect(download).toMatchObject({ version: '22.23.5' })
  expect(download?.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(download?.url).toBe('https://nodejs.org/dist/v22.23.5/node-v22.23.5-win-x64.zip')
})

it.each([['win32', 'v22.23.5'], ['win32', 'v22.19.0'], ['linux', 'v22.23.5']] as const)(
  'keeps a supported build host %s %s', (platform, version) => {
    expect(mcpBuildRuntimeDownload(platform, version)).toBeUndefined()
  })
it('selects target-specific runtimes without mixing x86 and x64 or operating systems', () => {
  for (const [os, arch, archive] of [['win32','ia32','win-x86.zip'],['win32','x64','win-x64.zip'],
    ['darwin','x64','darwin-x64.tar.gz'],['darwin','arm64','darwin-arm64.tar.gz'],['linux','x64','linux-x64.tar.xz']] as const) {
    expect(targetRuntimeDownload(os, arch)).toMatchObject({ version: '22.23.5', archive, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
  }
  expect(() => targetRuntimeDownload('linux', 'ia32')).toThrow('Unsupported')
})

it('propagates the selected runtime to nested Node commands without changing the caller environment', () => {
  const environment = { Path: 'original-path', NODE: 'old-node', npm_execpath: 'pnpm.cjs' }
  const next = mcpBuildEnvironment('/private/node.exe', environment)
  expect(next.PATH).toContain('original-path')
  expect(next.Path).toBeUndefined()
  expect(next.NODE).toBe('/private/node.exe')
  expect(next.npm_node_execpath).toBe('/private/node.exe')
  expect(next.npm_execpath).toBe('pnpm.cjs')
  expect(environment).toEqual({ Path: 'original-path', NODE: 'old-node', npm_execpath: 'pnpm.cjs' })
})
