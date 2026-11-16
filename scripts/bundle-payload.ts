/** Reproduce Tauri's documented fixed-width bundle marker in the qualified payload. */
export function installerPayloadBinary(original: Uint8Array, bundle: 'nsis'|'deb'|'dmg'): Buffer {
  const bytes=Buffer.from(original)
  if(bundle==='dmg')return bytes
  const marker=Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),position=bytes.indexOf(marker)
  if(position<0||bytes.indexOf(marker,position+1)>=0)throw new Error('Unexpected Tauri bundle marker layout')
  Buffer.from('__TAURI_BUNDLE_TYPE_VAR_'+(bundle==='nsis'?'NSS':'DEB')).copy(bytes,position)
  return bytes
}
