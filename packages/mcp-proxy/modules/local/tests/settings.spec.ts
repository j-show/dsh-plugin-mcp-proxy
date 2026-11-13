import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { readMcpProxySettings } from '../src/settings.ts'

it('loads the local product server and downstream configuration relative to its file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-proxy-settings-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const file = join(root, 'config.json')
  await writeFile(file, JSON.stringify({ server: { origin: 'https://agent.example', credentialRef: 'MCP_PROXY_TOKEN', caFile: 'certs/ca.pem' },
    directory: 'workspace', identityFile: 'identity/private.pem', services: [{ service: 'files', transport: 'stdio', command: 'node' }],
  }))
  expect(await readMcpProxySettings(file)).toMatchObject({ server: { credentialRef: 'MCP_PROXY_TOKEN', caFile: join(root, 'certs/ca.pem') },
    directory: join(root, 'workspace'), identityFile: join(root, 'identity/private.pem'),
    services: [{ service: 'files', cwd: join(root, 'workspace'), roots: [join(root, 'workspace')] }],
  })
})

it('rejects malformed settings without echoing secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-proxy-settings-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const file = join(root, 'config.json')
  await writeFile(file, '{"secret":"private-value",')
  await expect(readMcpProxySettings(file)).rejects.toThrow('Invalid or unreadable mcp-proxy configuration')
})

it.each([
  { server: { origin: 'http://agent.example', credentialRef: 'TOKEN' } },
  { server: { origin: 'https://agent.example/path', credentialRef: 'TOKEN' } },
  { server: { origin: 'https://agent.example', credentialRef: 'literal-secret-value' } },
  { unknown: true },
  { services: [{ service: 'a', transport: 'stdio', command: 'node' }, { service: 'a', transport: 'stdio', command: 'node' }] },
])('rejects invalid product configuration fields %#', async (override) => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-proxy-settings-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const file = join(root, 'config.json')
  await writeFile(file, JSON.stringify({ server: { origin: 'https://agent.example', credentialRef: 'TOKEN' },
    directory: '.', identityFile: 'identity.pem', services: [], ...override,
  }))
  await expect(readMcpProxySettings(file)).rejects.toThrow('Invalid or unreadable mcp-proxy configuration')
})
