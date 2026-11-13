import { expect, it } from 'vitest'
import { elicitationFields } from '../src/client/elicitation-fields.ts'

it('preserves titled and fallback choices, descriptions and primitive defaults', () => {
  const fields = elicitationFields({ type: 'object', required: ['text', 'flag', 'choices', 'number'], properties: {
    text: { type: 'string', description: 'Explain' }, flag: { type: 'boolean' }, number: { type: 'number' },
    choices: { type: 'array', items: { oneOf: [{ const: 'x', title: 'X' }, { const: 'y' }] } },
    select: { type: 'string', enum: ['a', 'b'], enumNames: ['A'] },
  } })
  expect(fields).toMatchObject([
    { name: 'text', label: 'text', description: 'Explain', kind: 'text', initial: '', required: true },
    { name: 'flag', kind: 'boolean', initial: false },
    { name: 'number', kind: 'number', initial: undefined, integer: false },
    { name: 'choices', kind: 'multi', initial: [], choices: [{ value: 'x', label: 'X' }, { value: 'y', label: 'y' }] },
    { name: 'select', kind: 'select', initial: undefined, choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'b' }] },
  ])
})

it.each([
  { type: 'array' },
  { type: 'object', properties: null },
  { type: 'object', properties: {}, required: 'field' },
  { type: 'object', properties: {}, required: [1] },
  { type: 'object', properties: { field: null } },
  { type: 'object', properties: { field: { type: 'object' } } },
  { type: 'object', properties: { field: { type: 'array', items: { type: 'string' } } } },
  { type: 'object', properties: { field: { type: 'string', enum: [1] } } },
  { type: 'object', properties: { field: { type: 'string', oneOf: [{ const: 1 }] } } },
])('refuses unsupported or malformed form metadata %#', (schema) => {
  expect(() => elicitationFields(schema)).toThrow()
})
