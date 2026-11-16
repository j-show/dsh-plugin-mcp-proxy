/** One shared compilation per aggregate build, also exposed as build:shared. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'tsdown'
import { buildLibraries } from './build-libraries.ts'
import { prepareMcpBuildRuntime, mcpBuildEnvironment } from './mcp-build-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'
import modules from './modules.json' with { type: 'json' }
import {withFileLock} from '@deepseek-ai/dsh-atomic-write'

export async function sharedFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (['node_modules','lib','tests','src-tauri','target'].includes(entry.name)) continue
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) { hash.update(relative(root, file).replaceAll('\\','/')); hash.update(await readFile(file)) }
    }
  }
  for (const file of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.base.json']) hash.update(await readFile(join(root,file)))
  await walk(join(root,'packages')); await walk(join(root,'scripts'))
  return hash.digest('hex')
}
export async function buildShared(root: string, development = false): Promise<{ directory: string; fingerprint: string }> {
  const directory = join(root, '.artifacts/shared')
  const fingerprint = await sharedFingerprint(root)
  try {
    const cached = JSON.parse(await readFile(join(directory,'build.json'),'utf8')) as { fingerprint: string; development: boolean; outputs: Array<{ path: string; sha256: string }> }
    if (cached.fingerprint === fingerprint && cached.development === development && cached.outputs?.length) {
      for (const row of cached.outputs) {
        if (!/^(?:packages\/[^.]+\/lib\/|\.artifacts\/shared\/)/.test(row.path) || row.path.split('/').includes('..')) throw new Error('Invalid shared output')
        if (createHash('sha256').update(await readFile(join(root,row.path))).digest('hex') !== row.sha256) throw new Error('Changed shared output')
      }
      process.stdout.write('Reusing verified shared build\n')
      return { directory, fingerprint }
    }
  } catch { /* Missing, stale or modified shared outputs are rebuilt from this checkout. */ }
  await buildLibraries(root, development)
  const desktop = join(directory, 'desktop'), resources = join(directory, 'resources')
  await mkdir(desktop, { recursive: true }); await mkdir(resources, { recursive: true })
  await build({ config: false, cwd: root, entry: { bootstrap: 'packages/mcp-proxy/src/client/bootstrap.ts' }, outDir: desktop,
    format: ['esm'], platform: 'browser', target: 'es2022', sourcemap: development, dts: false, clean: true })
  await build({ config: false, cwd: root, entry: { 'desktop-host': 'packages/mcp-proxy/src/desktop-host-entry.ts' }, outDir: resources,
    format: ['esm'], platform: 'node', target: 'node22', sourcemap: development, dts: false, clean: true,
    deps: { onlyBundle: false, neverBundle: [/^@j-show\//, /^@deepseek-ai\//] }, outputOptions: { entryFileNames: '[name].mjs' } })
  await copyFile(join(root,'packages/mcp-proxy/src/desktop-service-owner.mjs'),join(resources,'desktop-service-owner.mjs'))
  const html = (await readFile(join(root,'packages/mcp-proxy/src/client/index.html'),'utf8'))
    .replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]+>/, '').replace('src="renderer.js"','src="bootstrap.js"')
  await writeFile(join(desktop,'index.html'),html)
  await copyFile(join(root,'packages/mcp-proxy/src/client/styles.css'),join(desktop,'styles.css'))
  await copyFile(join(root,'packages/mcp-proxy/resources/icon-windows.png'),join(desktop,'app-icon.png'))
  const outputs: Array<{ path: string; sha256: string }> = []
  const collect = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder,{withFileTypes:true})) {
      if (entry.name === 'mcp-proxy.exe' || entry.name === 'build.json') continue
      const file = join(folder,entry.name)
      if (entry.isDirectory()) await collect(file)
      else if (entry.isFile()) outputs.push({ path: relative(root,file).replaceAll('\\','/'), sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
    }
  }
  for (const owner of modules.slice(1)) await collect(join(root,owner.directory,'lib'))
  await collect(desktop); await collect(resources)
  await writeFile(join(directory,'build.json'),JSON.stringify({ version:1, fingerprint, development, outputs })+'\n')
  return { directory, fingerprint }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname,'..'), node = await prepareMcpBuildRuntime(root)
  if (node) await runMcpBuildCommand(node,['--import','tsx/esm',...process.argv.slice(1)],root,mcpBuildEnvironment(node,process.env))
  else {
    await mkdir(join(root,'.artifacts'),{recursive:true})
    await withFileLock(join(root,'.artifacts/application-build.lock'),()=>buildShared(root),{waitMs:300000})
  }
}
