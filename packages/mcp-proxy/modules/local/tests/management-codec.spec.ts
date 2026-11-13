import { expect, it } from 'vitest'
import { parseLocalManagementCommand, parseLocalManagementReply } from '../src/management.ts'

it('accepts narrow commands and refuses arbitrary execution or additional fields', () => {
  expect(parseLocalManagementCommand({ kind: 'snapshot' })).toEqual({ kind: 'snapshot' })
  expect(() => parseLocalManagementCommand({ kind: 'approve', id: 'obsolete' })).toThrow('Invalid local management request')
  for (const request of [{ kind: 'run', command: 'arbitrary' }, { kind: 'snapshot', command: 'hidden' },
    { kind: 'disconnect', id: '../other' }]) expect(() => parseLocalManagementCommand(request)).toThrow('Invalid local management request')
})

it('rejects response data containing launch commands or credential fields instead of passing it to the renderer', () => {
  const snapshot = { version: 2, pid: 1, directory: '/workspace', settingsFile: '/settings.json',
    servers: [], services: [{ service: 'files', transport: 'stdio', ready: true }] }
  expect(parseLocalManagementReply({ ok: true, snapshot })).toMatchObject({ ok: true })
  expect(() => parseLocalManagementReply({ ok: true, snapshot: { ...snapshot,
    services: [{ ...snapshot.services[0], command: 'must-not-cross', env: { private: 'must-not-cross' } }] } }))
    .toThrow('Invalid local management reply')
})
