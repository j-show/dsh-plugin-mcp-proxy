import {expect,it} from 'vitest'
import {normalizePatchMetadata} from './pnpm-lock-compat.mjs'
import {readFile} from 'node:fs/promises'
import {load} from 'js-yaml'

it('normalizes only patch metadata while preserving locked dependencies and package integrity', () => {
  const before = "lockfileVersion: '9.0'\n\npatchedDependencies:\n  'example@1.0.0': abc123\n\nimporters:\n  .: {}\n"
  const after = normalizePatchMetadata(before,{'example@1.0.0':'packages/example.patch'})
  expect(after).toContain('hash: abc123')
  expect(after).toContain('path: packages/example.patch')
  expect(after.split('importers:')[1]).toBe(before.split('importers:')[1])
  expect(normalizePatchMetadata(after,{'example@1.0.0':'packages/example.patch'})).toBe(after)
  expect(() => normalizePatchMetadata(before,{'example@1.0.0':'../outside.patch'})).toThrow('location')
})
it('keeps compatibility settings synchronized and exposes only explicit platform builds',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
  const workspace=load(await readFile(new URL('../pnpm-workspace.yaml',import.meta.url),'utf8')) as Record<string,unknown>
  expect(manifest.engines.pnpm).toBe('>=10')
  expect(manifest.packageManager).toBeUndefined()
  expect(manifest.scripts.build).toBeUndefined()
  for(const key of ['packageExtensions','patchedDependencies','supportedArchitectures'])expect(manifest.pnpm[key]).toEqual(workspace[key])
  for(const key of ['build:shared','build:win:32','build:win:64','build:win','build:mac:intel','build:mac:arm','build:mac','build:linux'])expect(manifest.scripts[key]).toContain('scripts/tasks.ts')
})
