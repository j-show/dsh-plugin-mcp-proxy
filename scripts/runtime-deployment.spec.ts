import { expect, it, onTestFinished } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat, rmdir, readdir, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeDeploymentLinks, restoreDeploymentDependencies, pruneDeploymentWorkspaces } from './runtime-deployment.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-deploy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const stage = join(root, 'stage')
  const source = join(root, 'source')
  await mkdir(join(stage, 'node_modules'), { recursive: true })
  await mkdir(join(source, 'package/node_modules/private'), { recursive: true })
  await mkdir(join(source, 'package/modules/example/node_modules/private'), { recursive: true })
  await writeFile(join(source, 'package/index.js'), 'export const value = 1\n')
  await writeFile(join(stage, 'package.json'), JSON.stringify({ dependencies: { package: '1' } }))
  return { stage, source }
}

it('detaches deployed hard links before a later source build can change the payload', async () => {
  const { stage, source } = await setup()
  const destination = join(stage, 'node_modules/package')
  await mkdir(destination)
  await link(join(source, 'package/index.js'), join(destination, 'index.js'))
  await materializeDeploymentLinks(stage)
  await writeFile(join(source, 'package/index.js'), 'export const value = 2\n')
  expect(await readFile(join(destination, 'index.js'), 'utf8')).toBe('export const value = 1\n')
  expect(await readFile(join(source, 'package/index.js'), 'utf8')).toBe('export const value = 2\n')
})

it('restores a missing declared package without copying its source node_modules', async () => {
  const { stage, source } = await setup()
  expect(await restoreDeploymentDependencies(stage, source)).toEqual(['package'])
  expect(await readFile(join(stage, 'node_modules/package/index.js'), 'utf8')).toContain('value = 1')
  await expect(lstat(join(stage, 'node_modules/package/node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(join(stage, 'node_modules/package/modules/example/node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes unreferenced workspace hoists before materializing links without touching source packages',async()=>{
  const {stage,source}=await setup()
  const scope=join(stage,'node_modules/@fixture');await mkdir(scope)
  await symlink(join(source,'package'),join(scope,'server'),process.platform==='win32'?'junction':'dir')
  await mkdir(join(stage,'node_modules/.pnpm/node_modules/@fixture/server'),{recursive:true})
  await writeFile(join(stage,'node_modules/.pnpm/node_modules/@fixture/server/source.ts'),'not a runtime dependency')
  await pruneDeploymentWorkspaces(stage,new Set(['@fixture/server']))
  await expect(lstat(join(scope,'server'))).rejects.toMatchObject({code:'ENOENT'})
  await expect(lstat(join(stage,'node_modules/.pnpm/node_modules/@fixture/server'))).rejects.toMatchObject({code:'ENOENT'})
  expect(await readFile(join(source,'package/index.js'),'utf8')).toContain('value = 1')
})

it('materializes package links as independent files and preserves their sources', async () => {
  const { stage, source } = await setup()
  const destination = join(stage, 'node_modules/package')
  await symlink(join(source, 'package'), destination, process.platform === 'win32' ? 'junction' : 'dir')
  await materializeDeploymentLinks(stage)
  expect((await lstat(destination)).isSymbolicLink()).toBe(false)
  expect(await readFile(join(destination, 'index.js'), 'utf8')).toContain('value = 1')
  expect(await readFile(join(source, 'package/index.js'), 'utf8')).toContain('value = 1')
})

it('rejects dependency names that could escape the deployment directory', async () => {
  const { stage, source } = await setup()
  await writeFile(join(stage, 'package.json'), JSON.stringify({ dependencies: { '../escape': '1' } }))
  await expect(restoreDeploymentDependencies(stage, source)).rejects.toThrow('dependency')
})

it.each(['root', 'scope'])('refuses a linked %s dependency directory before writing to its external target', async (kind) => {
  const { stage, source } = await setup()
  const outside = join(source, 'outside')
  await mkdir(outside)
  const parent = kind === 'root' ? join(stage, 'node_modules') : join(stage, 'node_modules/@scope')
  if (kind === 'root') await rmdir(parent)
  else {
    await mkdir(join(source, '@scope/package'), { recursive: true })
    await writeFile(join(source, '@scope/package/index.js'), 'keep outside unchanged')
    await writeFile(join(stage, 'package.json'), JSON.stringify({ dependencies: { '@scope/package': '1' } }))
  }
  await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(restoreDeploymentDependencies(stage, source)).rejects.toThrow('real')
  expect(await readdir(outside)).toEqual([])
})
