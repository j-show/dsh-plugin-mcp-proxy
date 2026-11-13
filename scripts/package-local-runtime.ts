/** Package the Node profile for artifact-only integration tests and non-GUI administration. */
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'
import { tarballFiles } from './archive-members.ts'

const owners = ['protocol', 'local', 'runtime'] as const
interface Manifest { name: string; version: string; dependencies?: Record<string, string> }

/** @param root - Repository root. @param work - Owned staging directory. @param output - Local-product release directory. @returns Runtime archive path. */
export async function packageLocalRuntime(root: string, work: string, output: string): Promise<string> {
  const inputs = join(work, 'local-inputs')
  await mkdir(inputs, { recursive: true })
  const manifests: Manifest[] = []
  for (const owner of owners) {
    const directory = join(root, 'packages/mcp-proxy/modules', owner)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
    manifests.push(manifest)
    const pack = pnpmInvocation(['--config.verify-deps-before-run=false', '--dir', directory, 'pack', '--pack-destination', inputs])
    await runMcpBuildCommand(pack.command, pack.args, root)
  }
  const parent = manifests.at(-1)
  if (parent === undefined || manifests.some(manifest => manifest.version !== parent.version)) throw new Error('Local runtime version mismatch')
  const isolated = await mkdtemp(join(tmpdir(), 'mcp-local-pack-'))
  const stage = join(isolated, 'runtime')
  try {
    await mkdir(stage)
    for (const [index, manifest] of manifests.entries()) {
      const destination = index === 2 ? stage : join(stage, 'node_modules', manifest.name)
      await mkdir(destination, { recursive: true })
      await runMcpBuildCommand('tar', ['-xzf', join(inputs, filename(manifest)), '--strip-components=1', '-C', destination], root)
    }
    const bundled = manifests.slice(0, -1)
    const names = new Set(bundled.map(manifest => manifest.name))
    const dependencies: Record<string, string> = {}
    for (const manifest of manifests) for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (names.has(name)) continue
      if (dependencies[name] !== undefined && dependencies[name] !== range) throw new Error(`Conflicting runtime dependency: ${name}`)
      dependencies[name] = range
    }
    const normalized = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8')) as Manifest
    await writeFile(join(stage, 'package.json'), JSON.stringify({ ...normalized,
      dependencies: { ...dependencies, ...Object.fromEntries(bundled.map(manifest => [manifest.name, manifest.version])) },
      bundleDependencies: bundled.map(manifest => manifest.name),
    }, null, 2) + '\n')
    const pack = pnpmInvocation(['--config.verify-deps-before-run=false', '--config.node-linker=hoisted',
      '--dir', stage, 'pack', '--pack-destination', work])
    await runMcpBuildCommand(pack.command, pack.args, isolated)
  } finally {
    if (!isolated.startsWith(join(tmpdir(), 'mcp-local-pack-'))) throw new Error('Invalid local-runtime staging path')
    await rm(isolated, { recursive: true, force: true })
  }
  const packed = join(work, filename(parent))
  const members = tarballFiles(packed)
  if (members.some(member => !member.startsWith('package/') || member.split('/').includes('..'))) throw new Error('Invalid runtime archive path')
  for (const entry of ['package/lib/index.js', 'package/lib/startup.js', 'package/lib/desktop.js',
    'package/node_modules/@j-show/mcp-proxy-local/lib/index.js', 'package/node_modules/@j-show/mcp-proxy-protocol/lib/index.js']) {
    if (!members.includes(entry)) throw new Error(`Incomplete runtime archive: ${entry}`)
  }
  if (process.platform === 'win32' && !members.includes('package/lib/mcp-proxy.exe')) {
    throw new Error('Windows runtime archive lacks its URI helper')
  }
  await mkdir(output, { recursive: true })
  const result = join(output, filename(parent))
  const pending = result + '.' + process.pid + '.pending'
  await copyFile(packed, pending)
  await rename(pending, result)
  await access(result)
  return result
}

function filename(manifest: Manifest): string {
  return manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz'
}
