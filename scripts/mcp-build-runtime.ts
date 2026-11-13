/** Select a private build runtime without changing the developer's global Node installation. */
import { access, mkdir, mkdtemp } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import lock from './build-runtime-lock.json' with { type: 'json' }
import { downloadPrimaryRuntimeAsset } from './download-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'

/** Checksum-pinned Node archive from the project runtime lock. */
interface RuntimeDownload { readonly version: string; readonly url: string; readonly sha256: string }

/**
 * Select a replacement only for the affected Windows Node 24 releases.
 * @param platform - Build host platform.
 * @param version - Build host version including its v prefix.
 * @returns A locked download, or undefined when the current runtime is supported.
 */
export function mcpBuildRuntimeDownload(platform: NodeJS.Platform, version: string): RuntimeDownload | undefined {
  if (platform !== 'win32' || !/^v24\.(?:\d|1\d)\./.test(version)) return undefined
  const target = lock.targets['win-x64']
  return { version: lock.nodeVersion, sha256: target.nodeSha256,
    url: `https://nodejs.org/dist/v${lock.nodeVersion}/node-v${lock.nodeVersion}-${target.nodeArchive}` }
}

/**
 * Propagate the private executable to pnpm and nested Node commands.
 * @param executable - Selected Node filename.
 * @param environment - Inherited environment, retained unchanged.
 * @returns A child environment with one PATH entry and matching Node metadata.
 */
export function mcpBuildEnvironment(executable: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path')
  const entries = Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'path')
  return { ...Object.fromEntries(entries), PATH: dirname(executable) + delimiter + (pathKey ? environment[pathKey] ?? '' : ''),
    NODE: executable, npm_node_execpath: executable }
}

/**
 * Download a verified archive and extract into a unique build-only directory.
 * @param repository - Repository root containing ignored build artifacts.
 * @returns Private Node filename, or undefined when replacement is unnecessary.
 */
export async function prepareMcpBuildRuntime(repository: string): Promise<string | undefined> {
  const download = mcpBuildRuntimeDownload(process.platform, process.version)
  if (download === undefined) return undefined
  const cache = join(repository, '.artifacts/mcp-build-node')
  await mkdir(cache, { recursive: true })
  process.stdout.write(`Preparing isolated build Node ${download.version} (host ${process.version})\n`)
  const archive = await downloadPrimaryRuntimeAsset(download.url, download.sha256, cache)
  const directory = await mkdtemp(join(cache, 'runtime-'))
  await runMcpBuildCommand('tar', ['-xf', archive, '-C', directory], repository)
  const runtime = join(directory, `node-v${download.version}-win-x64`)
  await access(join(runtime, 'LICENSE'))
  const executable = join(runtime, 'node.exe')
  await runMcpBuildCommand(executable, ['-e', `if(process.versions.node !== ${JSON.stringify(download.version)}) process.exit(1)`], repository)
  return executable
}
