/** Native Tauri packaging; platform groups compile shared sources only once. */
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { appBuildPlan, bundleKinds, type AppTarget } from './app-targets.ts'
import { buildShared } from './build-shared.ts'
import { prepareMcpBuildRuntime, mcpBuildEnvironment, targetRuntimeDownload } from './mcp-build-runtime.ts'
import { downloadPrimaryRuntimeAsset } from './download-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'
import { packageMcpProxy } from './package-mcp-proxy.ts'
import { verifyMcpRuntimeImports } from './runtime-imports.ts'
import { writeRuntimeInventory } from './runtime-inventory.ts'
import { writeProductBuild } from './product-build.ts'
import { writeRustLicenses } from './rust-licenses.ts'
import {installerPayloadBinary} from './bundle-payload.ts'
import {createMacDiskImage} from './mac-disk-image.ts'
export interface AppBuildOutput { target: string; distribution: string; executable: string }
interface ConnectionPreset { origin: string; certificate: string }

async function packageTarget(root: string, target: AppTarget, shared: string, development: boolean, noBundle: boolean, presets: readonly ConnectionPreset[], deployment?: string): Promise<AppBuildOutput> {
  const parent = development ? join(root,'.artifacts/dev') : join(root,'.artifacts')
  await mkdir(parent,{recursive:true})
  const stage = await mkdtemp(join(parent,(development ? 'desktop-' : 'build-') + target.id + '-'))
  const resources = join(stage,'distribution/resources')
  await mkdir(resources,{recursive:true})
  const download = targetRuntimeDownload(target.platform,target.arch), cache = join(root,'.artifacts/runtime-downloads')
  await mkdir(cache,{recursive:true})
  const archive = await downloadPrimaryRuntimeAsset(download.url,download.sha256,cache)
  const extraction = join(stage,'node'); await mkdir(extraction)
  await runMcpBuildCommand('tar',['-xf',archive,'-C',extraction],root)
  const nodeRoot = join(extraction,`node-v${download.version}-${download.archive.replace(/\.(zip|tar\.gz|tar\.xz)$/,'')}`)
  const node = join(nodeRoot,target.platform === 'win32' ? 'node.exe' : 'bin/node')
  if (deployment) await cp(deployment,join(resources,'dsh'),{recursive:true})
  else await packageMcpProxy({ repository:root,output:join(resources,'dsh'),nodeExecutable:node,nodeLicense:join(nodeRoot,'LICENSE') })
  await copyFile(node,join(resources,'dsh/runtime',target.platform === 'win32' ? 'node.exe' : 'node'))
  await copyFile(join(nodeRoot,'LICENSE'),join(resources,'dsh/runtime/LICENSE'))
  await cp(join(shared,'resources'),resources,{recursive:true})
  await writeFile(join(resources,'connection-presets.json'),JSON.stringify(presets)+'\n')
  for (const name of ['LICENSE-MIT-UPSTREAM','THIRD_PARTY_NOTICES.md']) await copyFile(join(root,'packages/mcp-proxy',name),join(resources,name))
  await writeRustLicenses(root,join(resources,'rust-licenses'),target.triple)
  await writeFile(join(resources,'dsh/mcp-proxy-build.json'),JSON.stringify({ version:'0.1.6-alpha.2',node:download.version,platform:target.platform,arch:target.arch,profile:'mcp-proxy' })+'\n')
  const runtimeDigest = await writeRuntimeInventory(resources,target.platform,target.arch,download.version)
  if (target.arch === process.arch || (process.platform === 'win32' && target.arch === 'ia32')) await verifyMcpRuntimeImports(join(resources,'dsh'),join(resources,'dsh/runtime',target.platform === 'win32' ? 'node.exe' : 'node'))
  const config = join(stage,'tauri.json')
  await writeFile(config,JSON.stringify({ build:{frontendDist:join(shared,'desktop')},bundle:{targets:bundleKinds(target),resources:{[resources + '/']:'resources/'}} }))
  const require = createRequire(join(root,'package.json'))
  await runMcpBuildCommand('rustup',['target','add',target.triple],root)
  const cli = join(dirname(require.resolve('@tauri-apps/cli/package.json')),'tauri.js')
  const project = join(root,'packages/mcp-proxy'), cargoTarget = join(project,'src-tauri/target')
  await runMcpBuildCommand(process.execPath,[cli,'build','--target',target.triple,'--config',config,
    ...(development ? ['--debug'] : []),...(noBundle ? ['--no-bundle'] : ['--bundles',bundleKinds(target).join(',')])],project,
    {...process.env,MCP_PROXY_RUNTIME_SHA256:runtimeDigest})
  const binary = join(cargoTarget,target.triple,development ? 'debug' : 'release','mcp-proxy' + (target.platform === 'win32' ? '.exe' : ''))
  const applicationBinary=target.bundle==='dmg'&&!noBundle
    ?join(cargoTarget,target.triple,development?'debug':'release','bundle/macos/mcp-proxy.app/Contents/MacOS/mcp-proxy'):binary
  await writeFile(join(stage,'distribution',target.platform === 'win32' ? 'mcp-proxy.exe' : 'mcp-proxy'),
    noBundle?await readFile(applicationBinary):installerPayloadBinary(await readFile(applicationBinary),target.bundle),{mode:0o755})
  const published = join(root,'release/mcp-proxy',target.id)
  if (!noBundle) {
    await mkdir(published,{recursive:true})
    const bundles = join(cargoTarget,target.triple,development ? 'debug' : 'release','bundle',target.bundle)
    const suffix = target.bundle === 'nsis' ? '.exe' : target.bundle === 'dmg' ? '.dmg' : '.deb'
    const application = JSON.parse(await readFile(join(root,'package.json'),'utf8')) as {version:string}
    const architecture = target.platform === 'linux' ? 'amd64' : target.arch === 'ia32' ? 'x86' : target.arch === 'arm64' ? 'aarch64' : 'x64'
    if(target.bundle==='dmg')await createMacDiskImage(dirname(dirname(dirname(applicationBinary))),join(bundles,`mcp-proxy_${application.version}_${architecture}.dmg`),stage)
    const ending = '_' + architecture + (target.bundle === 'nsis' ? '-setup' : '') + suffix
    const candidates = (await readdir(bundles)).filter(file => file.startsWith(`mcp-proxy_${application.version}_`) && file.endsWith(ending))
    if (candidates.length !== 1) throw new Error('Expected one target installer')
    const installer = join(published,candidates[0]!)
    await mkdir(join(stage,'installer'))
    const original = join(stage,'installer',candidates[0]!)
    await copyFile(join(bundles,candidates[0]!),original)
    await copyFile(original,installer)
    await writeProductBuild(root,installer,join(stage,'distribution'),join(stage,'distribution',target.platform === 'win32' ? 'mcp-proxy.exe' : 'mcp-proxy'),target.id,original)
  }
  await writeFile(join(stage,'result.json'),JSON.stringify({target:target.id,distribution:join(stage,'distribution'),runtimeDigest,packaged:!noBundle})+'\n')
  process.stdout.write(`Tauri ${target.id}: ${noBundle ? join(stage,'distribution') : published}\n`)
  // The dependency closure includes the explicitly installed same-OS architectures.
  // Reuse this immutable closure, replacing only the checked target Node executable.
  return {target:target.id,distribution:join(stage,'distribution'),executable:join(stage,'distribution',target.platform === 'win32' ? 'mcp-proxy.exe' : 'mcp-proxy')}
}
export async function buildApplications(root: string, group: string, development = false, noBundle = false, presetsFile?: string): Promise<AppBuildOutput[]> {
  if (development) noBundle = true
  const targets = appBuildPlan(group,process.platform)
  await mkdir(join(root,'.artifacts'),{recursive:true})
  return withFileLock(join(root,'.artifacts/application-build.lock'),async () => {
    const shared = await buildShared(root,development)
    const parser = await import(pathToFileURL(join(root,'packages/mcp-proxy/src/bundled-connections.ts')).href) as { parseBundledConnections(value:unknown):readonly ConnectionPreset[] }
    const presets = presetsFile ? parser.parseBundledConnections(JSON.parse(await readFile(resolve(presetsFile),'utf8'))) : []
    if (process.platform === 'win32') await runMcpBuildCommand(process.execPath,['--import','tsx/esm','packages/mcp-proxy/modules/runtime/scripts/build-native-uri.mjs'],root)
    const outputs: AppBuildOutput[] = []
    let deployment: string | undefined
    for (const target of targets) {
      const product = await packageTarget(root,target,shared.directory,development,noBundle,presets,deployment)
      outputs.push(product)
      deployment = join(product.distribution,'resources/dsh')
    }
    return outputs
  },{waitMs:300000})
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname,'..')
  const {positionals,values} = parseArgs({allowPositionals:true,options:{development:{type:'boolean'},'no-bundle':{type:'boolean'},'connection-presets':{type:'string'}}})
  if (positionals.length !== 1) throw new Error('Choose an explicit platform build target')
  const node = await prepareMcpBuildRuntime(root)
  if (node) await runMcpBuildCommand(node,['--import','tsx/esm',...process.argv.slice(1)],root,mcpBuildEnvironment(node,process.env))
  else await buildApplications(root,positionals[0]!,!!values.development,!!values['no-bundle'],values['connection-presets'])
}
