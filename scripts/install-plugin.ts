/** Install the release through DSH, applying its explicitly versioned compatibility patch at the installation root. */
import { access, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { load, dump } from 'js-yaml'
import { execa } from 'execa'
import { assertNoSessionPatchOverlap, MCP_SESSION_EVENTS, SUPPORTED_DSH_VERSION } from './compatibility.ts'

const { values } = parseArgs({ options: { 'dsh-root': { type: 'string' }, 'dsh-cli': { type: 'string' },
  archive: { type: 'string' }, profile: { type: 'string', default: 'web' } } })
const root = resolve(values['dsh-root'] ?? process.cwd())
const manifestFile = join(root, 'package.json')
await access(manifestFile)
const require = createRequire(manifestFile)
const profile = values.profile
if (!profile || !/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error('Invalid DSH profile name')
const ownDirectory = import.meta.dirname
const release = JSON.parse(await readFile(join(ownDirectory, 'release.json'), 'utf8')) as { archive?: unknown }
if (typeof release.archive !== 'string' || !/^[A-Za-z0-9_.-]+\.tgz$/.test(release.archive)) throw new Error('Invalid plugin release metadata')
const archive = resolve(values.archive ?? join(ownDirectory, release.archive))
await access(archive)
let cli: string
let anchor: string
if (values['dsh-cli']) {
  cli = resolve(root, values['dsh-cli'])
  anchor = join(dirname(dirname(cli)), 'package.json')
} else {
  anchor = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(await readFile(anchor, 'utf8')) as { bin: { dsh: string } }
  cli = join(dirname(anchor), manifest.bin.dsh)
}
const dsh = JSON.parse(await readFile(anchor, 'utf8')) as { name: string; version: string }
if (dsh.name !== '@deepseek-ai/dsh' || dsh.version !== SUPPORTED_DSH_VERSION) throw new Error(`This release supports DSH ${SUPPORTED_DSH_VERSION} only`)
const compatible = async (): Promise<boolean> => {
  const code = `import{createRequire}from'node:module';import{readFileSync}from'node:fs';import{pathToFileURL}from'node:url';const r=createRequire(${JSON.stringify(anchor)});const p=JSON.parse(readFileSync(r.resolve('@deepseek-ai/dsh-session/package.json'),'utf8'));if(p.version!==${JSON.stringify(SUPPORTED_DSH_VERSION)})throw new Error('Unsupported installed session version');const m=await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-session')).href);if(${JSON.stringify(MCP_SESSION_EVENTS)}.every(x=>m.KNOWN_SESSION_EVENT_TYPES.has(x))){process.stdout.write('compatible')}else{process.stdout.write('needs-patch');process.exitCode=2}`
  const child = await execa(process.execPath, ['--input-type=module', '--eval', code], { cwd: root, reject: false })
  if (child.exitCode === 0 && child.stdout === 'compatible') return true
  if (child.exitCode === 2 && child.stdout === 'needs-patch') return false
  throw new Error('Unable to verify the installed DSH session runtime')
}
if (!await compatible()) {
  const workspace = join(root, 'pnpm-workspace.yaml')
  let previous: string | undefined
  try { previous = await readFile(workspace, 'utf8') } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const raw: unknown = previous === undefined ? {} : load(previous)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid pnpm workspace settings')
  const config = raw as Record<string, unknown>
  const existing = config.patchedDependencies
  if (existing !== undefined && (existing === null || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error('Invalid existing patchedDependencies')
  }
  const patches = { ...(existing as Record<string, string> | undefined) }
  const name = '@deepseek-ai/dsh-session@0.1.6-alpha.2'
  assertNoSessionPatchOverlap(patches)
  const directory = join(root, '.dsh-mcp-proxy')
  await mkdir(directory, { recursive: true })
  const patch = join(directory, 'dsh-session-0.1.6-alpha.2.patch')
  await copyFile(join(ownDirectory, 'dsh-session-0.1.6-alpha.2.patch'), patch)
  if (previous !== undefined) await writeFile(join(directory, `pnpm-workspace-${randomUUID()}.bak`), previous, { flag: 'wx' })
  patches[name] = '.dsh-mcp-proxy/dsh-session-0.1.6-alpha.2.patch'
  const pending = join(root, `pnpm-workspace-${randomUUID()}.pending`)
  await writeFile(pending, dump({ ...config, patchedDependencies: patches }), { flag: 'wx' })
  await rename(pending, workspace)
  await execa('pnpm', ['install', '--config.verify-deps-before-run=false'], { cwd: root, stdio: 'inherit', preferLocal: true })
  if (!await compatible()) throw new Error('DSH session compatibility verification failed after installation')
}
await execa(process.execPath, [cli, 'plugin', '--profile', profile, 'add', archive,
  '--config.verify-deps-before-run=false'], { cwd: root, stdio: 'inherit' })
process.stdout.write(`Installed mcp-proxy into DSH profile ${profile}\n`)
