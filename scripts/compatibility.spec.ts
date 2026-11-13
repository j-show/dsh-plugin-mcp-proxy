import { expect, it } from 'vitest'
import { assertNoSessionPatchOverlap } from './compatibility.ts'

it.each(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session@0.1.6-alpha.2', '@deepseek-ai/dsh-session@*',
  '@deepseek-ai/dsh-session@>=0.1.0'])('preserves an existing session patch keyed as %s', (name) => {
  expect(() => { assertNoSessionPatchOverlap({ [name]: 'existing.patch' }) }).toThrow('merged explicitly')
})

it('allows unrelated patches without altering them', () => {
  const patches = { '@deepseek-ai/dsh-session-query': 'query.patch' }
  expect(() => { assertNoSessionPatchOverlap(patches) }).not.toThrow()
  expect(patches).toEqual({ '@deepseek-ai/dsh-session-query': 'query.patch' })
})
