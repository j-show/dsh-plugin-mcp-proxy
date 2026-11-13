/** Build the two independent distributions from this repository alone. */
import { access, copyFile, mkdir, mkdtemp, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { prepareMcpBuildRuntime, mcpBuildEnvironment } from './mcp-build-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'
import { packageMcpProxy } from './package-mcp-proxy.ts'
import { packageMcpPlugin } from './package-mcp-plugin.ts'
import { buildLibraries } from './build-libraries.ts'
import { packageInstaller } from './package-installer.ts'
import { packageLocalRuntime } from './package-local-runtime.ts'

const root = resolve(import.meta.dirname, '..')
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  'skip-build': { type: 'boolean' }, 'electron-dist': { type: 'string' }, 'node-license': { type: 'string' },
  'connection-presets': { type: 'string' },
} })
const target = positionals[0]
if (positionals.length !== 1 || !['proxy', 'plugin', 'libraries'].includes(target ?? '')) throw new Error('Expected proxy, plugin or libraries')
if (target === 'proxy') {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required to build mcp-proxy.exe')
  const executable = await prepareMcpBuildRuntime(root)
  if (executable !== undefined) {
    await runMcpBuildCommand(executable, ['--import', 'tsx/esm', ...process.argv.slice(1)], root, mcpBuildEnvironment(executable, process.env))
    process.exit(0)
  }
}
if (!values['skip-build']) await buildLibraries(root)
if (target === 'libraries') process.exit(0)
await mkdir(join(root, '.artifacts'), { recursive: true })
const work = await mkdtemp(join(root, '.artifacts/build-' + target + '-'))
if (process.platform === 'win32') {
  await runMcpBuildCommand(process.execPath, ['--import', 'tsx/esm',
    'packages/mcp-proxy/modules/runtime/scripts/build-native-uri.mjs'], root)
}
await packageLocalRuntime(root, work, join(root, 'release/mcp-proxy'))
if (target === 'plugin') {
  const archive = await packageMcpPlugin(root, work, join(root, 'release/mcp-plugin'))
  await packageInstaller(root, join(root, 'release/mcp-plugin'))
  process.stdout.write(`DSH plugin: ${archive}\n`)
} else {
  const require = createRequire(join(root, 'packages/mcp-proxy/package.json'))
  const electronPackage = dirname(require.resolve('electron/package.json'))
  const electronDist = resolve(values['electron-dist'] ?? join(electronPackage, 'dist'))
  if (!values['electron-dist']) {
    try { await access(join(electronDist, 'electron.exe')) } catch (_error) {
      await runMcpBuildCommand(process.execPath, [join(electronPackage, 'install.js')], root)
    }
  }
  const runtime = join(work, 'runtime')
  await packageMcpProxy({ repository: root, output: runtime, nodeExecutable: process.execPath,
    nodeLicense: resolve(values['node-license'] ?? join(dirname(process.execPath), 'LICENSE')) })
  const args = ['--import', 'tsx/esm', 'packages/mcp-proxy/scripts/package-electron.ts', '--runtime', runtime,
    '--electron-dist', electronDist, '--out', join(work, 'electron')]
  if (values['connection-presets']) args.push('--connection-presets', resolve(values['connection-presets']))
  await runMcpBuildCommand(process.execPath, args, root)
  const output = join(root, 'release/mcp-proxy')
  await mkdir(output, { recursive: true })
  const pending = join(output, `mcp-proxy-${process.pid}.pending`)
  await copyFile(join(work, 'electron/distribution/mcp-proxy.exe'), pending)
  await rename(pending, join(output, 'mcp-proxy.exe'))
  process.stdout.write(`Windows client: ${join(output, 'mcp-proxy.exe')}\n`)
}
