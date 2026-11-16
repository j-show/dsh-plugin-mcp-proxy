/** Compile and bundle only this project's modules against published DSH APIs. */
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'tsdown'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'
import { buildBrowserClient } from './build-browser.ts'
import modules from './modules.json' with { type: 'json' }

/** @param root - Repository root. @returns After all owned public entries and the Web client are built. */
export async function buildLibraries(root: string, development = false): Promise<void> {
  await runMcpBuildCommand(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b', join(root, 'tsconfig.json')], root)
  const order = [1, 2, 3, 5, 6, 7, 8, 4]
  for (const index of order) {
    const owner = modules[index]
    if (owner === undefined) throw new Error('Missing build module')
    const directory = join(root, owner.directory)
    // Bundles can change chunk names; retain declarations/native helpers but not stale JS.
    for (const file of await readdir(join(directory,'lib'),{withFileTypes:true}).catch(() => [])) {
      if (file.isFile() && /\.(?:m?js|cjs)(?:\.map)?$/.test(file.name)) await unlink(join(directory,'lib',file.name))
    }
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; peerDependencies?: Record<string, string>
    }
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
    const extra = index === 1 ? ['src/activation.ts'] : index === 2 ? ['src/management.ts']
      : index === 3 ? ['src/startup.ts', 'src/desktop.ts']
        : index === 4 ? ['src/protocol.ts', 'src/agent.ts', 'src/host.ts', 'src/browser.ts'] : []
    await build({ config: false, cwd: directory, entry: ['src/index.ts', ...extra], outDir: 'lib',
      format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, sourcemap: development, clean: false,
      deps: { neverBundle: specifier => dependencies.some(name => specifier === name || specifier.startsWith(name + '/')) },
    })
  }
  await buildBrowserClient(root, development)
}
