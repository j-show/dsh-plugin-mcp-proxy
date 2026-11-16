import {expect,it} from 'vitest'
import {installerPayloadBinary} from './bundle-payload.ts'
it('binds the installer-specific bytes without ignoring arbitrary executable differences',()=>{
  const source=Buffer.from('prefix__TAURI_BUNDLE_TYPE_VAR_UNKsuffix')
  expect(installerPayloadBinary(source,'nsis').toString()).toBe('prefix__TAURI_BUNDLE_TYPE_VAR_NSSsuffix')
  expect(installerPayloadBinary(source,'deb').toString()).toBe('prefix__TAURI_BUNDLE_TYPE_VAR_DEBsuffix')
  expect(source.toString()).toContain('_UNK')
  expect(()=>installerPayloadBinary(Buffer.from('missing'),'nsis')).toThrow('marker')
  expect(()=>installerPayloadBinary(Buffer.concat([source,source]),'nsis')).toThrow('marker')
})
