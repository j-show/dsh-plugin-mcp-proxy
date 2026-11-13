/** Assemble one installable DSH bundle containing its five MCP adapter dependencies. */
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'
import { tarballFiles } from './archive-members.ts'

/** Packages shipped together; the final member owns the DSH bundle entry. */
export const mcpServerPackages = [
 {directory:'mcp-proxy/modules/protocol',name:'@j-show/mcp-proxy-protocol'},
 {directory:'dsh-plugin/modules/host',name:'@j-show/dsh-mcp-proxy-host'},
 {directory:'dsh-plugin/modules/agent',name:'@j-show/dsh-mcp-proxy-agent'},
 {directory:'dsh-plugin/modules/browser',name:'@j-show/dsh-mcp-proxy-browser'},
 {directory:'dsh-plugin/modules/ui',name:'@j-show/dsh-mcp-proxy-ui'},
 {directory:'dsh-plugin',name:'@j-show/dsh-plugin-mcp-proxy'},
] as const

interface Manifest { name: string; version: string; dependencies?: Record<string, string> }

/**
 * Assemble normalized npm payloads without workspace links or development files.
 * @param packages - Extracted package directories numbered in release order.
 * @param output - New staging directory for the parent bundle.
 * @returns When the parent and all same-version adapters have been copied.
 */
export async function stageMcpPlugin(packages: string, output: string): Promise<void> {
  const manifests = await Promise.all(mcpServerPackages.map(async (owner, index) => {
    const manifest = JSON.parse(await readFile(join(packages, String(index), 'package.json'), 'utf8')) as Manifest
    if (manifest.name !== owner.name || typeof manifest.version !== 'string') throw new Error('Invalid MCP package identity')
    await access(join(packages, String(index), 'lib/index.js'))
    return manifest
  }))
  const parent = manifests.at(-1)
  if (parent === undefined) throw new Error('MCP parent bundle missing')
  if (manifests.some(manifest => manifest.version !== parent.version)) throw new Error('MCP package version mismatch')
  await access(join(packages, '4/lib/client.js'))
  await access(join(packages, '5/cordis.patch.yml'))
  await cp(join(packages, '5'), output, { recursive: true, errorOnExist: true, force: false })
  const adapters = manifests.slice(0, -1)
  const bundledNames = new Set(adapters.map(adapter => adapter.name))
  const dependencies: Record<string, string> = {}
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (bundledNames.has(name)) continue
      if (dependencies[name] !== undefined && dependencies[name] !== range) throw new Error(`Conflicting dependency range: ${name}`)
      dependencies[name] = range
    }
  }
  for (const [index, adapter] of adapters.entries()) {
    const destination = join(output, 'node_modules', adapter.name)
    await mkdir(join(output, 'node_modules/@deepseek-ai'), { recursive: true })
    await cp(join(packages, String(index)), destination, { recursive: true, errorOnExist: true, force: false })
  }
  await writeFile(join(output, 'package.json'), JSON.stringify({ ...parent,
    dependencies: { ...dependencies, ...Object.fromEntries(adapters.map(adapter => [adapter.name, adapter.version])) },
    bundleDependencies: adapters.map(adapter => adapter.name),
  }, null, 2) + '\n')
}

/**
 * Pack built workspace adapters into one portable npm archive accepted by dsh plugin add.
 * @param repository - Built repository root.
 * @param work - Private build directory.
 * @param output - Release directory receiving the single bundle tarball.
 * @returns The absolute bundle tarball filename.
 */
export async function packageMcpPlugin(repository: string, work: string, output: string): Promise<string> {
  const archives = join(work, 'archives')
  await mkdir(archives, { recursive: true })
  for (const [index, owner] of mcpServerPackages.entries()) {
    const directory = join(repository, 'packages', owner.directory)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
    const invocation = pnpmInvocation(['--config.verify-deps-before-run=false', '--dir', directory,
      'pack', '--pack-destination', archives])
    await runMcpBuildCommand(invocation.command, invocation.args, repository)
    const destination = join(work, 'packages', String(index))
    await mkdir(destination, { recursive: true })
    await runMcpBuildCommand('tar', ['-xzf', join(archives, tarballName(manifest)), '--strip-components=1', '-C', destination], repository)
  }
  const stage = join(work, 'plugin')
  await stageMcpPlugin(join(work, 'packages'), stage)
  const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')) as Manifest
  // npm's bundled-dependency traversal must not resolve unrelated ancestor workspace packages.
  const isolated = await mkdtemp(join(tmpdir(), 'mcp-plugin-pack-'))
  try {
    const isolatedStage = join(isolated, 'plugin')
    await cp(stage, isolatedStage, { recursive: true, errorOnExist: true, force: false })
    const invocation = pnpmInvocation(['--config.verify-deps-before-run=false', '--config.node-linker=hoisted',
      '--dir', isolatedStage, 'pack', '--pack-destination', work])
    await runMcpBuildCommand(invocation.command, invocation.args, isolated)
  } finally {
    if (!isolated.startsWith(join(tmpdir(), 'mcp-plugin-pack-'))) throw new Error('Invalid temporary packaging directory')
    await rm(isolated, { recursive: true, force: true })
  }
  const packed = join(work, tarballName(manifest))
  validateMcpPluginMembers(tarballFiles(packed))
  await mkdir(output, { recursive: true })
  const archive = join(output, tarballName(manifest))
  const pending = join(output, `${tarballName(manifest)}.${process.pid}.pending`)
  await copyFile(packed, pending)
  await rename(pending, archive)
  return archive
}

/**
 * Reject incomplete bundled plugins and paths outside the npm package directory.
 * @param members - Paths reported by tar for the generated archive.
 */
export function validateMcpPluginMembers(members: readonly string[]): void {
  if (members.some(member => !member.startsWith('package/') || member.split('/').includes('..'))) {
    throw new Error('MCP archive contains a path outside its package')
  }
  for (const owner of mcpServerPackages.slice(0, -1)) {
    if (!members.includes(`package/node_modules/${owner.name}/package.json`)) throw new Error(`Bundled adapter missing: ${owner.name}`)
  }
  if (!members.includes('package/node_modules/@j-show/dsh-mcp-proxy-ui/lib/client.js')) {
    throw new Error('Bundled browser artifact missing')
  }
}

function tarballName(manifest: Manifest): string {
  return `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
}
