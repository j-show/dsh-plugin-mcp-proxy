// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from './support/props.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as common } from './support/common-zh.ts'
import { ConnectionSection, type ConnectionSectionProps } from '../../src/client/ConnectionSection.tsx'
import type { ConnectionState } from '../../src/client/controller.ts'
import { zh } from '../../src/client/locales.ts'

afterEach(cleanup)
function setup(state: ConnectionState) {
  const store = createSnapshotStore(state)
  const connect = vi.fn(async () => {})
  const disconnect = vi.fn(async () => {})
  const refresh = vi.fn(async () => {})
  const props = { useMcpProxyConnection: bindSnapshotSelector(store), connect, disconnect, refresh,
    t: makeTranslate(zh, common),
  } as unknown as ConnectionSectionProps
  render(<ConnectionSection {...props} />)
  return { connect, disconnect, refresh }
}

it('offers local connection without a Session or a device selector', () => {
  const view = setup({ phase: 'unbound', services: [], uri: null })
  fireEvent.click(screen.getByRole('button', { name: '连接这台电脑' }))
  expect(view.connect).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('shows confirmed services and a separate browser disassociation action', () => {
  const view = setup({ phase: 'connected', services: ['files'], uri: null })
  expect(screen.getByText('files')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '解除网页关联' }))
  expect(view.disconnect).toHaveBeenCalledTimes(1)
})

it('keeps activation pending with a manual protocol link and prevents duplicate connection gestures', () => {
  const uri = `mcp-proxy://associate/${'a'.repeat(43)}`
  setup({ phase: 'waiting', services: [], uri })
  expect((screen.getByRole('button', { name: '连接这台电脑' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('link', { name: '再次打开本机服务' }).getAttribute('href')).toBe(uri)
  expect(screen.queryByText('本机 MCP 已连接')).toBeNull()
})

it('shows a connected empty catalog and lets the user explicitly refresh its metadata', () => {
  const view = setup({ phase: 'connected', services: [], uri: null })
  expect(screen.getByText('已连接，尚未配置 MCP 服务。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '检查连接' }))
  expect(view.refresh).toHaveBeenCalledTimes(1)
})
