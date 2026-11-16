/** Bind each Tauri installer, application executable and runtime to the same successful build. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { appTargets } from './app-targets.ts'

export interface ProductBuild {
  version: 2; target: string; buildId: string; executable: string; runtime: string; installer: string; publishedInstaller: string
  executableSha256: string; installerSha256: string; manifestSha256: string
}
const receipt = 'release/mcp-proxy/product-build.json'
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const local = (root: string, path: string) => relative(root,path).split(sep).join('/')
async function safePath(root: string, path: string): Promise<string> {
  let current = resolve(root)
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part)) throw new Error('Invalid product build path')
    current = join(current,part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Linked product build path')
  }
  return current
}
export async function writeProductBuild(root: string, published: string, runtime: string,
  executable = join(runtime,'mcp-proxy.exe'), target = 'win-64', installer = join(dirname(runtime),'installer',basename(published))): Promise<void> {
  const buildId = local(root,runtime).split('/')[1]!
  const manifest = await safePath(root,local(root,join(runtime,'resources/mcp-runtime.json')))
  const value: ProductBuild = { version:2,target,buildId,executable:local(root,executable),runtime:local(root,runtime),
    installer:local(root,installer),publishedInstaller:local(root,published),
    executableSha256:digest(await readFile(await safePath(root,local(root,executable)))),
    installerSha256:digest(await readFile(await safePath(root,local(root,installer)))),manifestSha256:digest(await readFile(manifest)) }
  validate(value)
  for (const file of [receipt, `release/mcp-proxy/${target}/product-build.json`]) {
    const pending = join(root,file + '.' + randomUUID() + '.pending')
    await writeFile(pending,JSON.stringify(value,null,2)+'\n',{flag:'wx'})
    await rename(pending,join(root,file))
  }
}
function validate(value: ProductBuild): void {
  const target = appTargets[value.target]
  const base = `.artifacts/${value.buildId}`
  const binary = target?.platform === 'win32' ? 'mcp-proxy.exe' : 'mcp-proxy'
  if (value.version !== 2 || !target || !new RegExp(`^build-${target.id}-[A-Za-z0-9_-]+$`).test(value.buildId)
    || value.runtime !== `${base}/distribution` || value.executable !== `${base}/distribution/${binary}`
    || !value.installer.startsWith(base + '/installer/') || value.installer.slice((base+'/installer/').length).includes('/')
    || value.publishedInstaller !== `release/mcp-proxy/${target.id}/${basename(value.installer)}`
    || ![value.executableSha256,value.installerSha256,value.manifestSha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid product build path or hash')
}
export async function readProductBuild(root: string, target?: string): Promise<ProductBuild> {
  if (target && !appTargets[target]) throw new Error('Invalid product build target')
  let value: ProductBuild
  try { value = JSON.parse(await readFile(await safePath(root,target ? `release/mcp-proxy/${target}/product-build.json` : receipt),'utf8')) as ProductBuild }
  catch (error) { throw new Error('Cannot read product build record; run the platform build.',{cause:error}) }
  validate(value)
  if (target && value.target !== target) throw new Error('Product build target mismatch')
  const executable = await safePath(root,value.executable), runtime = await safePath(root,value.runtime)
  const installer = await safePath(root,value.installer), published = await safePath(root,value.publishedInstaller)
  if (digest(await readFile(executable)) !== value.executableSha256 || digest(await readFile(installer)) !== value.installerSha256
    || digest(await readFile(published)) !== value.installerSha256 || digest(await readFile(await safePath(root,value.runtime+'/resources/mcp-runtime.json'))) !== value.manifestSha256) throw new Error('Product build hash mismatch')
  return {...value,executable,runtime,installer,publishedInstaller:published}
}
