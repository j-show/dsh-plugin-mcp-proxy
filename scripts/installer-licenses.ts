/** Preserve license files for dependencies in the bundled installation helper. */
import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/** @param root - Repository root. @param output - Plugin release directory. */
export async function writeInstallerLicenses(root: string, output: string): Promise<void> {
  const seen = new Set<string>()
  async function visit(name: string, anchor: string): Promise<void> {
    const require = createRequire(anchor)
    let directory: string | undefined
    let manifest: { name: string; version: string; dependencies?: Record<string, string> } | undefined
    for (const search of require.resolve.paths(name) ?? []) {
      const candidate = join(search, name)
      try {
        const value = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) as NonNullable<typeof manifest>
        if (value.name === name) {
          manifest = value
          directory = await realpath(candidate)
          break
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      }
    }
    if (directory === undefined || manifest === undefined) throw new Error(`Dependency manifest not found: ${name}`)
    if (seen.has(directory)) return
    seen.add(directory)
    const destination = join(output, 'licenses', manifest.name.replaceAll('/', '__') + '@' + manifest.version)
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^(licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(entry.name)) {
        await copyFile(join(directory, entry.name), join(destination, entry.name))
      }
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await visit(dependency, join(directory, 'package.json'))
  }
  for (const dependency of ['execa', 'js-yaml']) await visit(dependency, join(root, 'package.json'))
  for (const name of ['LICENSE', 'LICENSE-MIT-UPSTREAM', 'THIRD_PARTY_NOTICES.md']) {
    await copyFile(join(root, name), join(output, name))
  }
}
