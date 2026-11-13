import { describe, expect, it } from 'vitest'
import { decodeFrame } from '../src/protocol.ts'

describe('MCP proxy wire admission', () => {
  it.each([
    { v: 1, kind: 'challenge', generation: 'g', nonce: 'n', origin: 'https://agent.example' },
    { v: 1, kind: 'register', endpointId: 'device', publicKey: 'key', signature: 'proof' },
    { v: 1, kind: 'ready', endpointId: 'device', generation: 'g' },
    { v: 1, kind: 'catalog-accepted', revision: 'r' },
    { v: 1, kind: 'invoke', id: 'c', generation: 'g', revision: 'r', service: 'files', name: 'read', args: { path: 'file.txt' }, timeoutMs: 100 },
    { v: 1, kind: 'cancel', id: 'c', generation: 'g' },
    { v: 1, kind: 'failure', id: 'c', generation: 'g', code: 'unknown', message: 'Connection lost' },
    { v: 1, kind: 'callback', id: 'b', parent: 'c', generation: 'g', method: 'sampling', params: { messages: [] } },
    { v: 1, kind: 'callback-result', id: 'b', parent: 'c', generation: 'g', response: { action: 'decline' } },
    { v: 1, kind: 'association', requestId: 'request' },
    { v: 1, kind: 'pong' },
  ])('admits valid protocol message %#', (frame) => {
    expect(decodeFrame(JSON.stringify(frame), 4096)).toEqual(frame)
  })
  it('preserves structured MCP results and metadata', () => {
    const frame = { v: 1, kind: 'result', id: 'call-1', generation: 'gen-1', result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { count: 2 }, _meta: { source: 'local' } } }
    expect(decodeFrame(JSON.stringify(frame), 4096)).toEqual(frame)
  })
  it('admits a service-qualified tool catalog', () => {
    const frame = { v: 1, kind: 'catalog', revision: 'catalog-1', services: [{ service: 'files' }], tools: [{ service: 'files', name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }] }
    expect(decodeFrame(JSON.stringify(frame), 4096)).toEqual(frame)
  })
  it('retains explicit local directory and roots context without interpreting foreign-platform paths', () => {
    const frame = { v: 1, kind: 'catalog', revision: 'r', services: [{ service: 'files',
      directory: 'C:\\work', roots: ['file:///C:/work'],
    }], tools: [] }
    expect(decodeFrame(JSON.stringify(frame), 4096)).toEqual(frame)
  })
  it.each([{ directory: '' }, { roots: ['https://remote.example/files'] }])('rejects invalid local directory metadata %#', (fields) => {
    expect(() => decodeFrame(JSON.stringify({ v: 1, kind: 'catalog', revision: 'r',
      services: [{ service: 'files', ...fields }], tools: [],
    }), 4096)).toThrow('Invalid MCP proxy frame')
  })
  it.each([
    { v: 2, kind: 'ping' },
    { v: 1, kind: 'unknown' },
    { v: 1, kind: 'invoke', id: 'call-1', generation: 'gen-1', revision: 'r', service: 'files', name: 'read', args: [], timeoutMs: 5 },
    { v: 1, kind: 'invoke', id: 'call-1', generation: 'gen-1', revision: 'r', service: 'files', name: 'read', args: {}, timeoutMs: 0 },
    { v: 1, kind: 'association', requestId: '' },
    { v: 1, kind: 'ping', extra: 'not allowed' },
  ])('rejects a malformed frame %#', (frame) => {
    expect(() => decodeFrame(JSON.stringify(frame), 4096)).toThrow('Invalid MCP proxy frame')
  })
  it('applies UTF-8 byte limits before parsing a frame', () => {
    expect(() => decodeFrame('"中文"', 7)).toThrow('byte limit')
  })
  it('admits a valid multibyte message exactly at its byte limit', () => {
    const frame = { v: 1, kind: 'failure', id: 'c', generation: 'g', code: 'failed', message: '中文' }
    const json = JSON.stringify(frame)
    const bytes = Buffer.byteLength(json, 'utf8')
    expect(decodeFrame(json, bytes)).toEqual(frame)
    expect(() => decodeFrame(json, bytes - 1)).toThrow('byte limit')
  })
  it.each([0, -1, Infinity, 1.5])('rejects invalid byte limit %s', (limit) => {
    expect(() => decodeFrame('{}', limit)).toThrow('positive safe integer')
  })
  it('redacts schema failures as well as JSON parser failures', () => {
    expect(() => decodeFrame(JSON.stringify({ v: 1, kind: 'association', requestId: 'not a valid secret' }), 4096)).toThrow(/^Invalid MCP proxy frame$/)
  })
  it('does not echo invalid JSON or credentials into errors', () => {
    expect(() => decodeFrame('{"secret":"not-a-real-secret"', 4096)).toThrow(/^Invalid MCP proxy JSON$/)
  })

  it('preserves instructions for a service with no tools', () => {
    const frame = { v: 1, kind: 'catalog', revision: 'r', services: [{ service: 'files', instructions: 'Only inspect the configured project.', serverInfo: { name: 'files', version: '1' } }], tools: [] }
    expect(decodeFrame(JSON.stringify(frame), 4096)).toEqual(frame)
  })

  it('correlates catalog rejection without inventing a tool invocation', () => {
    const frame = { v: 1, kind: 'catalog-rejected', revision: 'r', code: 'invalid-catalog' }
    expect(decodeFrame(JSON.stringify(frame), 4096)).toEqual(frame)
  })

  it.each(['failed', 'cancelled', 'expired', 'unsupported', 'unknown'])('represents callback %s explicitly', (code) => {
    const frame = { v: 1, kind: 'callback-failure', id: 'cb', parent: 'call', generation: 'gen', code }
    expect(decodeFrame(JSON.stringify(frame), 4096)).toEqual(frame)
  })

  it.each([
    { services: [{ service: 'files' }], tools: [{ service: 'other', name: 'read', inputSchema: {} }] },
    { services: [{ service: 'files' }, { service: 'files' }], tools: [] },
    { services: [{ service: 'files' }], tools: [{ service: 'files', name: 'read', inputSchema: {} }, { service: 'files', name: 'read', inputSchema: {} }] },
  ])('rejects catalog referent and identity conflicts %#', (catalog) => {
    expect(() => decodeFrame(JSON.stringify({ v: 1, kind: 'catalog', revision: 'r', ...catalog }), 4096)).toThrow('Invalid MCP proxy frame')
  })
})
