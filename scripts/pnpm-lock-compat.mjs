/** Keep the pnpm v9 lock format readable by the first pnpm 10 release and later managers. */
import {readFile,lstat,writeFile,rename} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {load,dump} from 'js-yaml'

export function normalizePatchMetadata(text, patches) {
  const value = load(text)
  if (!value?.patchedDependencies) return text
  let changed = false
  const entries = {}
  for (const [name, metadata] of Object.entries(value.patchedDependencies)) {
    const path = patches?.[name]
    if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new Error('Invalid project patch location')
    entries[name] = typeof metadata === 'string' ? {hash:metadata,path} : metadata
    if (typeof metadata === 'string') changed = true
    else if (metadata.path !== path) throw new Error('Project patch metadata mismatch')
  }
  if (!changed) return text
  const block = dump({patchedDependencies:entries},{lineWidth:-1,noRefs:true})+'\n'
  return text.replace(/^patchedDependencies:\r?\n(?:(?:[ \t].*|)\r?\n)*/m,block)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)),'..'), file = join(root,'pnpm-lock.yaml')
  if ((await lstat(file)).isSymbolicLink()) throw new Error('Linked project lockfile')
  const manifest = JSON.parse(await readFile(join(root,'package.json'),'utf8'))
  const original = await readFile(file,'utf8'), updated = normalizePatchMetadata(original,manifest.pnpm?.patchedDependencies)
  if (updated !== original) {
    const pending = join(root,'pnpm-lock-'+randomUUID()+'.pending')
    await writeFile(pending,updated,{flag:'wx'}); await rename(pending,file)
  }
}
