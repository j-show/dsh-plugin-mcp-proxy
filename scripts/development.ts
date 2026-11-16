/** Project-owned development state; never uses a consumer checkout or user profile. */
import { access, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { generateDevelopmentTls } from './development-tls.ts'
export { generateDevelopmentTls } from './development-tls.ts'

export const DEVELOPMENT_ORIGIN = 'https://localhost:3443'
const execute = promisify(execFile)
export interface DevelopmentTools { readonly node: string; readonly pnpm: string; readonly tar: boolean; readonly compiler: boolean; readonly license: boolean }
/** Pure preflight diagnostics, also usable before installing dependencies. */
export function developmentIssues(tools: DevelopmentTools, packaging: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const issues: string[] = []
  const [, major, minor] = /^v(\d+)\.(\d+)/.exec(tools.node) ?? []
  if (Number(major) !== 22 || Number(minor) < 19) issues.push('Use Node 22.19+.')
  const pnpm = /^(\d+)\.\d+\.\d+(?:\+[A-Za-z0-9.-]+)?$/.exec(tools.pnpm)
  if (!pnpm || !Number.isSafeInteger(Number(pnpm[1])) || Number(pnpm[1]) < 10) issues.push('Use pnpm >=10.')
  if (packaging && !tools.tar) issues.push('Install tar.')
  if (packaging && platform === 'win32' && !tools.compiler) issues.push('Enable the Windows .NET Framework 4.x compiler.')
  return issues
}

/** All generated absolute paths derive from this checkout, never committed machine paths. */
export function developmentPaths(repository: string) {
  const root = resolve(repository, '.artifacts/dev')
  return { root, home: join(root, 'server-home'), localHome: join(root, 'client-home'), tls: join(root, 'tls'),
    workspace: join(root, 'workspace'), localAppData: join(root, 'local-app-data'), logs: join(root, 'logs'),
    settings: join(root, 'settings.json'), presets: join(root, 'connection-presets.json') }
}
export type DevelopmentPaths = ReturnType<typeof developmentPaths>

async function regularDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Development paths must not be symbolic links')
}
async function createFile(path: string, contents: string): Promise<void> {
  try { await writeFile(path, contents, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Development file must be a regular file')
  }
}
async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** Claim an empty development directory, preserving all existing settings on retries. */
export async function initializeDevelopment(repository: string,
  generateTls: (directory: string) => Promise<void> = generateDevelopmentTls, protect = true): Promise<DevelopmentPaths> {
  const p = developmentPaths(repository)
  await regularDirectory(join(resolve(repository), '.artifacts'))
  await regularDirectory(p.root)
  const marker = join(p.root, 'owner.json')
  const owner = JSON.stringify({ version: 1, repository: await realpath(repository) })
  if (!await exists(marker) && (await readdir(p.root)).length !== 0) throw new Error('Development directory is not owned by this checkout')
  await createFile(marker, owner)
  if (await readFile(marker, 'utf8') !== owner) throw new Error('Development directory is not owned by this checkout')
  if (protect && process.platform === 'win32') {
    const { stdout } = await execute('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    const sid = /S-1-[\d-]+/.exec(stdout)?.[0]
    if (!sid) throw new Error('Unable to protect private development state')
    await execute('icacls', [p.root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true })
  }
  for (const directory of [p.home, p.localHome, p.tls, p.workspace, p.localAppData, p.logs]) await regularDirectory(directory)
  const ca = await exists(join(p.tls, 'ca.pem'))
  const key = await exists(join(p.tls, 'server.pfx'))
  if (ca !== key) throw new Error('Incomplete development TLS; retain diagnostics and explicitly replace the tls directory')
  if (!ca) await generateTls(p.tls)
  for (const file of ['ca.pem', 'server.pfx']) {
    const stat = await lstat(join(p.tls, file))
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Development TLS must use regular files')
  }
  await createFile(p.settings, JSON.stringify({ version: 2, directory: p.workspace, identityFile: join(p.root, 'identity.yaml'),
    servers: [], services: [{ service: 'files', transport: 'stdio', command: process.execPath,
      args: [join(resolve(repository), 'packages/mcp-proxy/modules/local/tests/fixtures/files.mjs')], cwd: p.workspace, roots: [p.workspace], env: {} }] }, null, 2) + '\n')
  await createFile(p.presets, JSON.stringify([{ origin: DEVELOPMENT_ORIGIN, certificate: await readFile(join(p.tls, 'ca.pem'), 'utf8') }], null, 2) + '\n')
  await createFile(join(p.home, '.env'), '# Personal model keys may be added here. Never commit this file.\n')
  await createFile(join(p.home, 'cordis.patch.yml'), '[]\n')
  await createFile(join(p.localHome, 'cordis.patch.yml'), '[]\n')
  return p
}

/** Public app-boot owns profile construction; project-local junctions expose this checkout's packages. */
export async function initializeDevelopmentProfiles(repository: string, p: DevelopmentPaths): Promise<void> {
  const { initProfile } = await import('@deepseek-ai/dsh-app-boot')
  const profiles = [
    { home: p.home, name: 'web', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@j-show/dsh-plugin-mcp-proxy'], local: 'packages/dsh-plugin', package: '@j-show/dsh-plugin-mcp-proxy' },
    { home: p.localHome, name: 'mcp-proxy', bundles: ['@j-show/mcp-proxy-runtime'], local: 'packages/mcp-proxy/modules/runtime', package: '@j-show/mcp-proxy-runtime' },
  ]
  for (const profile of profiles) {
    const directory = join(profile.home, 'profiles', profile.name)
    await regularDirectory(join(profile.home, 'profiles'))
    await regularDirectory(directory)
    initProfile(directory, profile.bundles)
    const filename = join(directory, 'package.json')
    for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
      const stat = await lstat(join(directory, file))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Development profile files must be regular files')
    }
    const manifest = JSON.parse(await readFile(filename, 'utf8'))
    if (!manifest.dsh?.profile?.bundles?.includes(profile.package)) throw new Error('Existing development profile is missing its local bundle; inspect before changing it')
    if (!manifest.dependencies?.[profile.package]) {
      await writeFile(filename, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, [profile.package]: '0.1.0' } }, null, 2) + '\n')
    }
    const target = resolve(repository, profile.local)
    const link = join(directory, 'node_modules', profile.package)
    await regularDirectory(join(directory, 'node_modules'))
    await regularDirectory(dirname(link))
    if (await exists(link)) {
      if (await realpath(link) !== await realpath(target)) throw new Error('Development profile package points to another checkout')
    } else await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

/** Resolve only publicly declared DSH dependencies, including their transitive CLI bundle packages. */
export function developmentDshCli(repository: string): string {
  const require = createRequire(join(repository, 'package.json'))
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  return join(dirname(manifest), 'lib/bin.js')
}
