/** Assemble the local MCP product from the real dsh CLI and a private deployment closure. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, chmod, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { materializeDeploymentLinks, restoreDeploymentDependencies, pruneDeploymentWorkspaces } from './runtime-deployment.ts'
import modules from './modules.json' with {type:'json'}

/** Explicit build inputs; the official executable and license must match the requested target. */
export interface McpProxyPackageOptions {
  readonly repository: string
  readonly output: string
  readonly nodeExecutable: string
  readonly nodeLicense: string
  readonly environment?: NodeJS.ProcessEnv
}
type Run = (command: string, args: readonly string[], cwd: string) => Promise<void>
/**
 * Keep build orchestration on the supported Node 22 line.
 * @param platform - build host platform.
 * @param version - build host's Node version.
 */
export function assertMcpProxyBuildRuntime(_platform: NodeJS.Platform, version: string): void {
  const match = /^v22\.(\d+)\./.exec(version)
  if (!match || Number(match[1]) < 19) throw new Error('MCP builds require Node 22.19+')
}
/**
 * @param options - build inputs and a new output directory.
 * @param run - shell-free command owner.
 * @returns after copying the portable payload; an interrupted build leaves its owned directory for inspection.
 */
export async function packageMcpProxy(options: McpProxyPackageOptions, run?: Run): Promise<void> {
  assertMcpProxyBuildRuntime(process.platform, process.version)
  const repository = resolve(options.repository)
  const output = resolve(options.output)
  const require = createRequire(join(repository, 'packages/mcp-proxy/package.json'))
  const cliRoot = dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  try { await access(join(cliRoot, 'lib/bin.js')) } catch (_error) { throw new Error('Build the dsh CLI before packaging mcp-proxy') }
  const cli: unknown = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'))
  if (typeof cli !== 'object' || cli === null || !('name' in cli) || cli.name !== '@deepseek-ai/dsh'
    || !('version' in cli) || typeof cli.version !== 'string' || !('bin' in cli)) throw new Error('Invalid dsh CLI installation manifest')
  const license = await readFile(options.nodeLicense)
  if (license.length === 0) throw new Error('A Node runtime license is required')
  await access(options.nodeExecutable)
  await mkdir(dirname(output), { recursive: true })
  try { await mkdir(output) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('Portable output already exists')
    throw error
  }
  const invocation = pnpmInvocation(['--filter', '@j-show/mcp-proxy', 'deploy', '--legacy', '--prod',
    '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true', output], options.environment)
  await (run ?? execute)(invocation.command, invocation.args, repository)
  const manifests=new Map(await Promise.all(modules.map(async module=>[module.name,
    JSON.parse(await readFile(join(repository,module.directory,'package.json'),'utf8')) as {dependencies?:Record<string,string>;peerDependencies?:Record<string,string>} ] as const)))
  const required=new Set<string>()
  function visit(name:string):void{
    if(required.has(name))return
    required.add(name)
    const manifest=manifests.get(name)
    for(const dependency of Object.keys({...manifest?.dependencies,...manifest?.peerDependencies}))if(manifests.has(dependency))visit(dependency)
  }
  visit('@j-show/mcp-proxy')
  await pruneDeploymentWorkspaces(output,new Set(modules.filter(module=>!required.has(module.name)||module.name==='@j-show/mcp-proxy').map(module=>module.name)))
  await restoreDeploymentDependencies(output, join(repository, 'packages/mcp-proxy/node_modules'))
  await materializeDeploymentLinks(output)
  const deployed: unknown = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
  if (typeof deployed !== 'object' || deployed === null || !('version' in deployed) || typeof deployed.version !== 'string'
    || !('dependencies' in deployed)) throw new Error('Invalid MCP runtime deployment manifest')
  const { dsh: _trees, devDependencies: _dev, ...manifest } = cli as Record<string, unknown>
  await writeFile(join(output, 'package.json'), JSON.stringify({ ...manifest, private: true, dependencies: deployed.dependencies }, null, 2) + '\n')
  await cp(join(cliRoot, 'lib'), join(output, 'lib'), { recursive: true })
  await mkdir(join(output, 'runtime'))
  const node = process.platform === 'win32' ? 'node.exe' : 'node'
  await copyFile(options.nodeExecutable, join(output, 'runtime', node))
  await chmod(join(output, 'runtime', node), 0o755)
  await writeFile(join(output, 'runtime/LICENSE'), license)
  for (const file of ['README.md', 'README.zh.md', 'settings.example.json']) {
    await copyFile(join(repository, 'packages/mcp-proxy', file), join(output, file))
  }
  const local = join(output, 'node_modules/@j-show/mcp-proxy-runtime/lib')
  await access(join(local, 'startup.js'))
  if (process.platform === 'win32') await access(join(local, 'mcp-proxy.exe'))
  if (process.platform === 'win32') {
    await writeFile(join(output, 'mcp-proxy.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0lib\\bin.js" --profile mcp-proxy %*\r\n')
  } else {
    await writeFile(join(output, 'mcp-proxy'), '#!/bin/sh\nBASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit\n'
      + 'exec "$BASE/runtime/node" "$BASE/lib/bin.js" --profile mcp-proxy "$@"\n', { mode: 0o755 })
  }
  await writeFile(join(output, 'mcp-proxy-build.json'), JSON.stringify({ version: cli.version, node: process.version,
    platform: process.platform, arch: process.arch, profile: 'mcp-proxy',
  }, null, 2) + '\n')
}

async function execute(command: string, args: readonly string[], cwd: string): Promise<void> {
  const child = spawn(command, [...args], { cwd, stdio: 'inherit', shell: false, windowsHide: true })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`Portable dependency deployment failed (${signal ?? code})`))
    })
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'node-license': { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) { process.stdout.write('Build a local mcp-proxy folder: --out <new-directory> --node-license <file>\n'); return }
  if (values.out === undefined || values['node-license'] === undefined) throw new Error('--out and --node-license are required')
  await packageMcpProxy({ repository: resolve(import.meta.dirname, '..'), output: values.out,
    nodeExecutable: process.execPath, nodeLicense: values['node-license'],
  })
  process.stdout.write(`Local mcp-proxy runtime: ${resolve(values.out)}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
