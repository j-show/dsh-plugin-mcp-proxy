/** Package the Electron local client as a Windows portable executable. */
import { access, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { build as bundle } from 'tsdown'
import { Arch, Platform, build } from 'electron-builder'
import { writeElectronRuntimeManifest } from '../src/runtime-cache.ts'
import { installPortableWorkingDirectoryCapture } from './portable-cwd.ts'
import { verifyMcpRuntimeImports } from '../../../scripts/runtime-imports.ts'
import { electronChildEnvironment } from '../src/profile-launch.ts'
import { parseBundledConnections } from '../src/bundled-connections.ts'
import { withWindowsBuildDrive } from '../../../scripts/windows-build-drive.ts'

const { values } = parseArgs({ options: { runtime: { type: 'string' }, 'electron-dist': { type: 'string' }, out: { type: 'string' },
  'connection-presets': { type: 'string' }, development: { type: 'boolean' } } })
if (process.platform !== 'win32') throw new Error('Electron mcp-proxy packaging requires Windows')
if (!values.runtime || !values['electron-dist'] || !values.out) throw new Error('--runtime, --electron-dist and --out are required')
const project = resolve(import.meta.dirname, '..')
const runtime = resolve(values.runtime)
const output = resolve(values.out)
const electronDist = resolve(values['electron-dist'])
await access(join(runtime, 'lib/bin.js'))
await access(join(electronDist, 'electron.exe'))
await verifyMcpRuntimeImports(runtime, process.execPath)
await mkdir(output)
const stage = join(output, 'bootstrap')
await mkdir(stage)
let presets: ReturnType<typeof parseBundledConnections> = []
if (values['connection-presets'] !== undefined) {
  try { presets = parseBundledConnections(JSON.parse(await readFile(resolve(values['connection-presets']), 'utf8')) as unknown) }
  catch (_error) { throw new Error('Invalid bundled connection metadata') }
}
const presetFile = join(output, 'connection-presets.json')
await writeFile(presetFile, JSON.stringify(presets) + '\n')
const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')) as { version: string }
// A sandboxed preload cannot require a shared local CommonJS chunk.
const mainEntry = values.development ? 'src/development-main.ts' : 'src/main.ts'
for (const entry of [mainEntry, 'src/preload.ts']) {
  await bundle({ config: false, cwd: project, entry: [entry], outDir: stage, format: ['cjs'], fixedExtension: true,
    platform: 'node', target: 'es2024', dts: false, sourcemap: values.development ?? false, clean: entry === mainEntry,
    deps: { alwaysBundle: [/^@deepseek-ai\//, /^@j-show\//, /^zod(?:\/|$)/], neverBundle: ['electron', 'original-fs'] },
  })
}
await bundle({ config: false, cwd: project, entry: ['src/client/renderer.ts'], outDir: stage, format: ['esm'],
  platform: 'browser', target: 'es2024', dts: false, sourcemap: values.development ?? false, clean: false })
for (const name of ['index.html', 'styles.css']) await copyFile(join(project, 'src/client', name), join(stage, name))
await copyFile(resolve(project, './resources/icon-windows.png'), join(stage, 'app-icon.png'))
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'mcp-proxy', productName: 'mcp-proxy',
  version: manifest.version, description: 'Local MCP connectivity client', author: 'j-show',
  dependencies: {}, devDependencies: {}, main: values.development ? 'development-main.cjs' : 'main.cjs',
}))
await mkdir(join(stage, 'node_modules'))
const electronVersion = createRequire(join(project, 'package.json'))('electron/package.json').version as string
const config = { appId: 'io.github.jshow.mcp-proxy', productName: 'mcp-proxy', executableName: 'mcp-proxy',
  directories: { app: stage, output: join(output, 'distribution') },
  electronVersion, electronDist, asar: true, npmRebuild: false, forceCodeSigning: false,
  files: ['*.cjs', '*.js', ...(values.development ? ['*.map'] : []), 'index.html', 'styles.css', 'app-icon.png', 'package.json'],
  extraResources: [{ from: runtime, to: 'dsh', filter: ['**/*', '!runtime/**', '!mcp-proxy.cmd'] },
    { from: presetFile, to: 'connection-presets.json' },
    { from: join(project, 'LICENSE-MIT-UPSTREAM'), to: 'LICENSE-MIT-UPSTREAM' },
    { from: join(project, 'THIRD_PARTY_NOTICES.md'), to: 'THIRD_PARTY_NOTICES.md' }],
  win: { signAndEditExecutable: false }, portable: { artifactName: 'mcp-proxy.exe', unpackDirName: true, useZip: true },
  ...(values.development ? { asar: false } : {}),
}
await build({ projectDir: stage, targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), config: structuredClone(config) })
const unpacked = join(output, 'distribution/win-unpacked')
await access(join(unpacked, 'resources/connection-presets.json'))
// extraResources omits node_modules; publish the already materialized closure explicitly.
await cp(join(runtime, 'node_modules'), join(unpacked, 'resources/dsh/node_modules'),
  { recursive: true, force: false, errorOnExist: true })
for (const name of ['README.md', 'README.zh.md']) await copyFile(join(project, name), join(unpacked, 'resources/dsh', name))
await access(join(unpacked, 'resources/dsh/node_modules/@j-show/mcp-proxy-runtime/lib/startup.js'))
await verifyMcpRuntimeImports(join(unpacked, 'resources/dsh'), join(unpacked, 'mcp-proxy.exe'),
  { ...electronChildEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1' })
const require = createRequire(createRequire(join(project, 'package.json')).resolve('electron-builder'))
const { getNsisElevatePath } = require('app-builder-lib/out/toolsets/windows.js') as { getNsisElevatePath(): Promise<string> }
await copyFile(await getNsisElevatePath(), join(unpacked, 'resources/elevate.exe'))
await writeElectronRuntimeManifest(unpacked)
installPortableWorkingDirectoryCapture()
if (!values.development) await withWindowsBuildDrive(output, async shortRoot => {
  const shortStage = join(shortRoot, 'bootstrap')
  await build({ projectDir: shortStage, prepackaged: join(shortRoot, 'distribution/win-unpacked'),
    targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64),
    config: { ...structuredClone(config), directories: { app: shortStage, output: join(shortRoot, 'distribution') } },
  })
})
process.stdout.write(`Electron local client: ${join(output, 'distribution/mcp-proxy.exe')}\n`)
