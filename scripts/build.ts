/** Package the independent DSH plugin using the verified shared compilation. */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { buildShared } from './build-shared.ts'
import { packageMcpPlugin } from './package-mcp-plugin.ts'
import { packageInstaller } from './package-installer.ts'

const root = resolve(import.meta.dirname,'..')
const {positionals} = parseArgs({allowPositionals:true,options:{}})
if (positionals.length !== 1 || positionals[0] !== 'plugin') throw new Error('Use build:mcp-plugin')
await mkdir(join(root,'.artifacts'),{recursive:true})
await withFileLock(join(root,'.artifacts/application-build.lock'),async () => {
  await buildShared(root)
  const work = await mkdtemp(join(root,'.artifacts/build-plugin-'))
  const archive = await packageMcpPlugin(root,work,join(root,'release/mcp-plugin'))
  await packageInstaller(root,join(root,'release/mcp-plugin'))
  process.stdout.write(`DSH plugin: ${archive}\n`)
},{waitMs:300000})
