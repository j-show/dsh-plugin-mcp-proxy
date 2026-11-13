import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { parseManagedMcpSettings } from '../src/managed-settings.ts'

const server = { id: 'a', origin: 'https://a.example', enabled: true, mode: 'device', identityRef: 'DEVICE_A' }
const settings = { version: 2, directory: 'workspace', identityFile: 'identity.yaml', services: [], servers: [server] }

it('accepts an empty GUI configuration and resolves local paths independently of DSH origins', () => {
  const parsed = parseManagedMcpSettings({ ...settings, servers: [] }, process.cwd())
  expect(parsed.servers).toEqual([])
  expect(parsed.directory).toBe(resolve('workspace'))
  expect(parsed.identityFile).toBe(resolve('identity.yaml'))
})

it('keeps two independently disabled or enabled DSHs sharing one local MCP list', () => {
  const parsed = parseManagedMcpSettings({ ...settings, servers: [server, { ...server, id: 'b', origin: 'https://b.example',
    enabled: false, identityRef: 'DEVICE_B' }] }, process.cwd())
  expect(parsed.servers.map(entry => entry.enabled)).toEqual([true, false])
  expect(parsed.services).toEqual([])
})

it.each([
  { ...settings, servers: [server, server] },
  { ...settings, servers: [{ ...server, origin: 'http://a.example' }] },
  { ...settings, servers: [{ ...server, origin: 'https://a.example/path' }] },
  { ...settings, servers: [{ ...server, mode: 'legacy' }] },
  { ...settings, servers: [{ ...server, privateKey: 'must-not-appear-in-errors' }] },
])('rejects ambiguous or untrusted GUI configuration without including values', (input) => {
  expect(() => parseManagedMcpSettings(input, process.cwd())).toThrow('Invalid managed MCP configuration')
})
