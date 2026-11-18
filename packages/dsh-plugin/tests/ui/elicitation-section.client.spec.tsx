// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from './support/props.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as common } from './support/common-zh.ts'
import { ElicitationDock, type ElicitationDockProps } from '../../src/client/ElicitationDock.tsx'
import { elicitationFields } from '../../src/client/elicitation-fields.ts'
import type { ElicitationState, ElicitationId } from '../../src/client/elicitation-controller.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ElicitationId
function setup(state: ElicitationState) {
  const store = createSnapshotStore(state)
  const answer = vi.fn(async () => {})
  const refreshElicitation = vi.fn(async () => {})
  const props = { useMcpProxyElicitation: bindSnapshotSelector(store), answer, refreshElicitation,
    t: makeTranslate(zh, common),
  } as unknown as ElicitationDockProps
  render(<ElicitationDock {...props} />)
  return { answer, refreshElicitation }
}

it('submits primitive form values without turning zero or false into missing answers', () => {
  const fields = elicitationFields({ type: 'object', required: ['name', 'count', 'confirm'], properties: {
    name: { type: 'string', title: 'Name' }, count: { type: 'integer', title: 'Count', default: 0 },
    confirm: { type: 'boolean', title: 'Confirm' }, color: { type: 'string', title: 'Color', enum: ['red', 'blue'], enumNames: ['Red', 'Blue'] },
    tags: { type: 'array', title: 'Tags', items: { anyOf: [{ const: 'x', title: 'X' }, { const: 'y', title: 'Y' }] } },
  } })
  const { answer } = setup({ pending: { id, params: { mode: 'form', message: 'Choose values', fields } }, busy: false, error: false })
  fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Ada' } })
  fireEvent.change(screen.getByLabelText('Color'), { target: { value: '0' } })
  const tags = screen.getByLabelText('Tags') as HTMLSelectElement
  for (const option of tags.options) option.selected = true
  fireEvent.change(tags)
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  expect(answer).toHaveBeenCalledWith(id, 'accept', { name: 'Ada', count: 0, confirm: false, color: 'red', tags: ['x', 'y'] })
})

it('shows a URL as an explicit external link and sends no automatic answer', () => {
  const url = 'https://auth.example/start?token=live-only'
  const { answer } = setup({ pending: { id, params: { mode: 'url', message: 'Complete sign in', url } }, busy: false, error: false })
  const link = screen.getByRole('link', { name: '打开页面' })
  expect(link.getAttribute('href')).toBe(url)
  expect(link.getAttribute('rel')).toContain('noreferrer')
  expect(answer).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  expect(answer).toHaveBeenCalledWith(id, 'accept', undefined)
})

it('omits an untouched optional multi-select that forbids an empty array', () => {
  const fields = elicitationFields({ type: 'object', properties: {
    tags: { type: 'array', title: 'Tags', minItems: 1, items: { type: 'string', enum: ['x', 'y'] } },
  } })
  const { answer } = setup({ pending: { id, params: { mode: 'form', message: 'Optional tags', fields } }, busy: false, error: false })
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  expect(answer).toHaveBeenCalledWith(id, 'accept', {})
})

it('preserves an explicit empty string when the user clears an optional default', () => {
  const fields = elicitationFields({ type: 'object', properties: { note: { type: 'string', title: 'Note', default: 'old' } } })
  const { answer } = setup({ pending: { id, params: { mode: 'form', message: 'Optional note', fields } }, busy: false, error: false })
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  expect(answer).toHaveBeenCalledWith(id, 'accept', { note: '' })
})

it('preserves numeric edits and checked booleans while omitting cleared optional fields', () => {
  const fields = elicitationFields({ type: 'object', required: ['count', 'confirm'], properties: {
    count: { type: 'integer', title: 'Count', description: 'Exact amount', default: 1 },
    optional: { type: 'number', title: 'Optional amount', default: 2.5 },
    confirm: { type: 'boolean', title: 'Confirm' },
    choice: { type: 'string', title: 'Choice', enum: ['x', 'y'], default: 'x' },
  } })
  const { answer } = setup({ pending: { id, params: { mode: 'form', message: 'Edit values', fields } }, busy: false, error: false })
  expect(screen.getByText('Exact amount')).toBeTruthy()
  expect(screen.getByLabelText('Count *').getAttribute('step')).toBe('1')
  expect(screen.getByLabelText('Optional amount').getAttribute('step')).toBe('any')
  fireEvent.change(screen.getByLabelText('Count *'), { target: { value: '7' } })
  fireEvent.change(screen.getByLabelText('Optional amount'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Choice'), { target: { value: '-1' } })
  fireEvent.click(screen.getByLabelText('Confirm *'))
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  expect(answer).toHaveBeenCalledWith(id, 'accept', { count: 7, confirm: true })
})

it('presents explicit decline and cancellation independently of submitting form values', () => {
  const { answer } = setup({ pending: { id, params: { mode: 'form', message: 'Decide', fields: [] } }, busy: false, error: false })
  fireEvent.click(screen.getByRole('button', { name: '不提供' }))
  fireEvent.click(screen.getByRole('button', { name: '取消请求' }))
  expect(answer.mock.calls).toEqual([[id, 'decline'], [id, 'cancel']])
})

it('allows retrying a read failure when no pending question is available', () => {
  const { refreshElicitation } = setup({ pending: null, busy: false, error: true })
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '检查连接' }))
  expect(refreshElicitation).toHaveBeenCalledTimes(1)
})

it('renders no request controls when no question is pending', () => {
  setup({ pending: null, busy: false, error: false })
  expect(screen.queryByRole('button')).toBeNull()
})
