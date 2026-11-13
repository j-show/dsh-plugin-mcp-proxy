import { expect, it } from 'vitest'
import { mcpBuildRuntimeDownload, mcpBuildEnvironment } from './mcp-build-runtime.ts'

it('selects a checksum-pinned isolated runtime for affected Windows Node versions', () => {
  const download = mcpBuildRuntimeDownload('win32', 'v24.15.0')
  expect(download).toMatchObject({ version: '24.21.0' })
  expect(download?.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(download?.url).toBe('https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip')
})

it.each([['win32', 'v24.20.0'], ['win32', 'v22.19.0'], ['linux', 'v24.15.0']] as const)(
  'keeps a supported build host %s %s', (platform, version) => {
    expect(mcpBuildRuntimeDownload(platform, version)).toBeUndefined()
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
