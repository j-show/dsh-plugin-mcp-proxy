import {expect,it} from 'vitest'
import {readFile} from 'node:fs/promises'
import {load} from 'js-yaml'
import {nativeMatrix} from './ci-matrix.ts'

it('defers Intel Mac by default and wires the native matrix to the explicit retry input',async()=>{
  const workflow=load(await readFile(new URL('../.github/workflows/verify.yml',import.meta.url),'utf8')) as {
    on?:{workflow_dispatch?:{inputs?:{mac_intel_runner?:{default?:string}}}}
    jobs:{native:{strategy:{matrix:unknown}};shared:{outputs?:{native_matrix?:string}}}
  }
  expect(workflow.on?.workflow_dispatch?.inputs?.mac_intel_runner?.default).toBe('')
  expect(workflow.jobs.shared.outputs?.native_matrix).toBe('${{ steps.native_matrix.outputs.matrix }}')
  expect(workflow.jobs.native.strategy.matrix).toBe('${{ fromJSON(needs.shared.outputs.native_matrix) }}')
})
it('keeps Windows x86/x64, ARM Mac and Ubuntu active while Intel Mac remains unverified',()=>{
  const lanes=nativeMatrix().include
  expect(lanes.map(row=>row.target)).toEqual(['win-64','mac-arm','linux'])
  expect(lanes[0]?.rust).toBe('i686-pc-windows-msvc x86_64-pc-windows-msvc')
})
it('permits an explicit alternate Mac runner retry and rejects malformed runner labels',()=>{
  expect(nativeMatrix('new-intel-mac').include.find(row=>row.target==='mac-intel')).toEqual({
    os:'new-intel-mac',build:'build:mac:intel',target:'mac-intel',rust:'x86_64-apple-darwin',
  })
  expect(()=>nativeMatrix('mac\nother')).toThrow('runner label')
})
