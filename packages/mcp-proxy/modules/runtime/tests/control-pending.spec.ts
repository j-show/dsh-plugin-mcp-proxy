import { expect, it, vi } from 'vitest'

vi.mock('node:net', async () => {
  const actual = await vi.importActual<typeof import('node:net')>('node:net')
  // A real Socket without an OS connect completion models a busy IPC transport.
  return { ...actual, createConnection: () => new actual.Socket() }
})

import { forwardLocalAssociation } from '../src/control.ts'

it('settles the local activation deadline even before the IPC connection opens', { timeout: 1000 }, async () => {
  await expect(forwardLocalAssociation('pending-control-fixture', 'a'.repeat(43), 10)).rejects.toThrow('unavailable')
})
