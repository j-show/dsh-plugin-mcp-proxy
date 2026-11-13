import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { stageMcpPlugin, mcpServerPackages, validateMcpPluginMembers } from './package-mcp-plugin.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-plugin-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const packages = join(root, 'packages')
  for (const [index, owner] of mcpServerPackages.entries()) {
    const folder = join(packages, String(index))
    await mkdir(join(folder, 'lib'), { recursive: true })
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name: owner.name, version: '1.0.0',
      dependencies: { '@deepseek-ai/schemastery': '^3.0.0', ...(index === 1 ? { ws: '^8.0.0' } : {}) },
      ...(owner.name==='@j-show/dsh-plugin-mcp-proxy' ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
    }))
    await writeFile(join(folder, 'lib/index.js'), 'export const ready = true\n')
    if (owner.name.endsWith('-ui')) await writeFile(join(folder, 'lib/client.js'), 'export const client = true\n')
    if (owner.name === '@j-show/dsh-plugin-mcp-proxy') await writeFile(join(folder, 'cordis.patch.yml'), '[]\n')
  }
  return { packages, output: join(root, 'plugin') }
}

it('bundles every adapter and its browser artifact behind one DSH plugin entry', async () => {
  const { packages, output } = await fixture()
  await stageMcpPlugin(packages, output)
  const manifest = JSON.parse(await readFile(join(output, 'package.json'), 'utf8')) as {
    dsh: { bundle: { patch: string } }
    bundleDependencies: string[]
    dependencies: Record<string, string>
  }
  expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(manifest.bundleDependencies).toHaveLength(5)
  expect(manifest.dependencies['@j-show/mcp-proxy-protocol']).toBe('1.0.0')
  expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('^3.0.0')
  expect(manifest.dependencies.ws).toBe('^8.0.0')
  expect(await readFile(join(output, 'node_modules/@j-show/dsh-mcp-proxy-ui/lib/client.js'), 'utf8'))
    .toContain('client = true')
})

it('refuses a package whose version differs from the parent bundle', async () => {
  const { packages, output } = await fixture()
  await writeFile(join(packages, '0/package.json'), JSON.stringify({ name: mcpServerPackages[0].name, version: '2.0.0' }))
  await expect(stageMcpPlugin(packages, output)).rejects.toThrow('version')
})

it('rejects bundled dependency traversal outside the package', () => {
  expect(() => { validateMcpPluginMembers(['package/../../../node_modules/unrelated/package.json']) })
    .toThrow('path outside')
})

it('requires the browser artifact as well as every bundled adapter manifest', () => {
  const manifests = mcpServerPackages.slice(0, -1).map(owner => `package/node_modules/${owner.name}/package.json`)
  expect(() => { validateMcpPluginMembers(manifests) }).toThrow('browser artifact missing')
  expect(() => {
    validateMcpPluginMembers([...manifests, 'package/node_modules/@j-show/dsh-mcp-proxy-ui/lib/client.js'])
  }).not.toThrow()
})
