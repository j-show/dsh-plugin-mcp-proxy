/** Publish the self-contained server installation helper and its compatibility patch. */
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'tsdown'
import { writeInstallerLicenses } from './installer-licenses.ts'

/** @param root - Repository root. @param output - Plugin release directory. @returns After installation assets are emitted. */
export async function packageInstaller(root: string, output: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'packages/dsh-plugin/package.json'), 'utf8')) as { name: string; version: string }
  const archive = manifest.name.replace('@', '').replace('/', '-') + '-' + manifest.version + '.tgz'
  await writeFile(join(output, 'release.json'), JSON.stringify({ format: 1, archive, dsh: '0.1.6-alpha.2' }, null, 2) + '\n')
  await build({ config: false, cwd: root, entry: { install: 'scripts/install-plugin.ts' }, outDir: output,
    format: ['esm'], platform: 'node', target: 'es2024', dts: false, sourcemap: false, clean: false,
    deps: { alwaysBundle: [/^js-yaml(?:\/|$)/, /^execa(?:\/|$)/], onlyBundle: false },
    outputOptions: { entryFileNames: 'install.mjs' },
  })
  await copyFile(join(root, 'packages/dsh-plugin/compat/dsh-session-0.1.6-alpha.2.patch'),
    join(output, 'dsh-session-0.1.6-alpha.2.patch'))
  await writeInstallerLicenses(root, output)
  await writeFile(join(output, 'README.md'), '# DSH MCP plugin\n\nRun with Node in the DSH package-manager installation root:\n\n```sh\nnode install.mjs --dsh-root <installation-root>\n```\n\nThe helper verifies DSH 0.1.6-alpha.2, applies the four-event compatibility patch only when missing, and uses the public DSH plugin installer. Set DSH_HOME for an existing custom profile home. Use --dsh-cli <relative-bin-path> for a source installation. Stop DSH before changing its runtime dependencies.\n')
}
