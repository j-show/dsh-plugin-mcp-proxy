/** Assemble the local MCP product from the real dsh CLI and a private deployment closure. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, chmod, copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { pnpmInvocation } from './run-mcp-build-command.ts'
import { materializeDeploymentLinks, restoreDeploymentDependencies, pruneDeploymentWorkspaces } from './runtime-deployment.ts'

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
  const invocation = pnpmInvocation(['--filter', '@jshow/app-mcp-proxy', 'deploy', '--legacy', '--prod',
    '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true', output], options.environment)
  await (run ?? execute)(invocation.command, invocation.args, repository)
  await pruneDeploymentWorkspaces(output,new Set(['@jshow/dsh-plugin-mcp-proxy','@jshow/app-mcp-proxy']))
  const app=join(output,'node_modules/@jshow/app-mcp-proxy')
  await mkdir(app,{recursive:true})
  for(const file of ['package.json','cordis.patch.yml','LICENSE','THIRD_PARTY_NOTICES.md'])await copyFile(join(repository,'packages/mcp-proxy',file),join(app,file))
  await mkdir(join(app,'lib'))
  for(const file of await readdir(join(repository,'packages/mcp-proxy/lib'),{withFileTypes:true})){
    if(file.isFile()&&/\.(?:js|js\.map|d\.ts|exe)$/.test(file.name))await copyFile(join(repository,'packages/mcp-proxy/lib',file.name),join(app,'lib',file.name))
  }
  await restoreDeploymentDependencies(output, join(repository, 'packages/mcp-proxy/node_modules'))
  await materializeDeploymentLinks(output)
  const deployed: unknown = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
  if (typeof deployed !== 'object' || deployed === null || !('version' in deployed) || typeof deployed.version !== 'string'
    || !('dependencies' in deployed)||typeof deployed.dependencies!=='object'||deployed.dependencies===null||Array.isArray(deployed.dependencies)) throw new Error('Invalid MCP runtime deployment manifest')
  const { dsh: _trees, devDependencies: _dev, ...manifest } = cli as Record<string, unknown>
  await writeFile(join(output, 'package.json'), JSON.stringify({ ...manifest, private: true,
    dependencies: {...deployed.dependencies,'@jshow/app-mcp-proxy':deployed.version} }, null, 2) + '\n')
  await cp(join(cliRoot, 'lib'), join(output, 'lib'), { recursive: true })
  await mkdir(join(output, 'runtime'))
  const node = process.platform === 'win32' ? 'node.exe' : 'node'
  await copyFile(options.nodeExecutable, join(output, 'runtime', node))
  await chmod(join(output, 'runtime', node), 0o755)
  await writeFile(join(output, 'runtime/LICENSE'), license)
  for (const file of ['README.md', 'README.zh.md', 'settings.example.json']) {
    await copyFile(join(repository, 'packages/mcp-proxy', file), join(output, file))
  }
  const local = join(output, 'node_modules/@jshow/app-mcp-proxy/lib')
  await access(join(local, 'runtime-startup.js'))
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
