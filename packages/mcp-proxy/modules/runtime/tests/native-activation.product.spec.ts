/** Compiled native activation against the serialized machine control resource. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { compileWindowsUriHelper } from '../src/native-builder.ts'
import { listenLocalControl, machineControlAddress, type LocalControlServer } from '../src/control.ts'
import { acquireServiceSlot } from './product-service-slot.ts'

it.skipIf(process.platform !== 'win32' || process.env.MCP_PROXY_PRODUCT_TESTS !== '1').each([true, false])('forwards once to the ready owner without starting another GUI, accepted=%s',
  { timeout: 180000 },
  async (accepted) => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-native-activation-'))
    const scope: { release?: () => Promise<void>; control?: LocalControlServer } = {}
    onTestFinished(async () => {
      try { await scope.control?.close() } finally {
        try { await scope.release?.() } finally { await rm(root, { recursive: true, force: true }) }
      }
    })
    scope.release = await acquireServiceSlot()
    const received: unknown[] = []
    scope.control = await listenLocalControl(await machineControlAddress(), { timeoutMs: 5000, maxConnections: 4 },
      async () => { throw new Error('Unexpected legacy frame') }, undefined, () => true, {
        maxRequestBytes: 131072, maxResponseBytes: 1048576,
        handle: async (request) => {
          received.push(request)
          return accepted ? { ok: true, snapshot: { version: 2, pid: process.pid, directory: root,
            settingsFile: join(root, 'settings.json'), services: [], servers: [] } } : { ok: false, code: 'pairing-failed' }
        },
      })
    const entry = await compileWindowsUriHelper(root, 10000)
    await writeFile(join(root, 'launcher.json'), JSON.stringify({ node: join(root, 'not-running.exe'), associateArgs: '',
      home: root, desktop: true, installTimeoutMs: 5000 }))
    const uri = `mcp-proxy://associate/${'a'.repeat(43)}?v=2&origin=https%3A%2F%2Fdsh.example`
    const activation = promisify(execFile)(entry, [uri], { timeout: 10000, windowsHide: true })
    if (accepted) await activation
    else await expect(activation).rejects.toMatchObject({ code: 4 })
    expect(received).toEqual([{ kind: 'activate', uri }])
    await expect(readFile(join(root, 'not-running.exe'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
