import { expect, it, onTestFinished } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { developmentIssues, initializeDevelopment, initializeDevelopmentProfiles, developmentPaths } from './development.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-development-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

it('reports unsupported tools and packaging prerequisites without changing the host', () => {
  expect(developmentIssues({ node: 'v20.0.0', pnpm: '9.15.0', tar: false, compiler: false }, true, 'win32'))
    .toEqual(expect.arrayContaining(['Use Node 22.19+.', 'Use pnpm >=10.', 'Install tar.', 'Enable the Windows .NET Framework 4.x compiler.']))
})

it('accepts pnpm 10 and later releases without requiring an exact package-manager version', () => {
  const tools = { node: 'v22.23.5', tar: true, compiler: true }
  for (const pnpm of ['10.0.0', '10.26.0', '11.7.0', '12.0.0']) {
    expect(developmentIssues({ ...tools, pnpm }, false)).toEqual([])
  }
  for (const pnpm of ['', '9.15.0', '10', '10.0.0-beta.1', 'not-a-version']) {
    expect(developmentIssues({ ...tools, pnpm }, false)).toContain('Use pnpm >=10.')
  }
})

it('initializes owned state and preserves settings and credentials on repeat', async () => {
  const root = await fixture()
  const generate = async (directory: string) => { await writeFile(join(directory, 'ca.pem'), 'test CA'); await writeFile(join(directory, 'server.pfx'), 'test PFX') }
  const p = await initializeDevelopment(root, generate, false)
  const settings = JSON.parse(await readFile(p.settings, 'utf8'))
  expect(settings.version).toBe(2)
  expect(settings.servers).toEqual([])
  expect(settings.services[0].cwd).toBe(p.workspace)
  expect(settings.services[0].args[0]).toBe(join(root, 'packages/mcp-proxy/modules/local/tests/fixtures/files.mjs'))
  await writeFile(p.settings, JSON.stringify({ ...settings, services: [] }))
  await writeFile(join(p.home, 'private-marker'), 'keep')
  await initializeDevelopment(root, () => { throw new Error('must not regenerate identity') }, false)
  expect(JSON.parse(await readFile(p.settings, 'utf8')).services).toEqual([])
  expect(await readFile(join(p.home, 'private-marker'), 'utf8')).toBe('keep')
})

it('refuses unowned data and refuses directory junctions', async () => {
  const root = await fixture()
  const p = developmentPaths(root)
  await mkdir(p.root, { recursive: true })
  await writeFile(join(p.root, 'user-file'), 'keep')
  await expect(initializeDevelopment(root, async () => {}, false)).rejects.toThrow('not owned')
  const other = await fixture()
  await mkdir(join(other, '.artifacts'))
  await symlink(p.root, developmentPaths(other).root, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(initializeDevelopment(other, async () => {}, false)).rejects.toThrow('symbolic')
  expect(await readFile(join(p.root, 'user-file'), 'utf8')).toBe('keep')
})

it('rejects damaged certificate pairs instead of silently replacing trust', async () => {
  const root = await fixture()
  const p = await initializeDevelopment(root, async d => { await writeFile(join(d, 'ca.pem'), 'test'); await writeFile(join(d, 'server.pfx'), 'test') }, false)
  await rm(join(p.tls, 'server.pfx'))
  await expect(initializeDevelopment(root, async () => {}, false)).rejects.toThrow('Incomplete development TLS')
})

it('refuses unsupported development bundles without rewriting custom configuration',async()=>{
  const root=await fixture()
  const p=await initializeDevelopment(root,async d=>{await writeFile(join(d,'ca.pem'),'test');await writeFile(join(d,'server.pfx'),'test')},false)
  const directory=join(p.home,'profiles/web');await mkdir(directory,{recursive:true})
  const file=join(directory,'package.json'),before=JSON.stringify({custom:'keep',dsh:{profile:{bundles:['@fixture/retired-plugin']}}})
  await writeFile(file,before)
  await expect(initializeDevelopmentProfiles(root,p)).rejects.toThrow('missing its local bundle')
  expect(await readFile(file,'utf8')).toBe(before)
})
