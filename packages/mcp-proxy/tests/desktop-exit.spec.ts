import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  confirm: vi.fn(async () => ({ response: 0 })),
  quit: vi.fn(),
  menu: [] as Array<{ label?: string; click?: () => void }>,
}))

vi.mock('electron', () => ({
  app: { requestSingleInstanceLock: () => true, on: vi.fn(), getLocale: () => 'en', getAppPath: () => '.', exit: fixture.quit },
  BrowserWindow: class {
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn() } }
    on = vi.fn()
    loadFile = async () => {}
    show = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    isDestroyed = () => false
  },
  Tray: class { on = vi.fn(); setToolTip = vi.fn(); setContextMenu = vi.fn(); destroy = vi.fn() },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  Menu: { buildFromTemplate: (menu: typeof fixture.menu) => { fixture.menu = menu; return menu } },
  dialog: { showMessageBox: fixture.confirm },
  ipcMain: { handle: vi.fn() },
}))

import { runDesktop } from '../src/desktop-main.ts'

it('exits directly from the tray without a second confirmation, including during failed startup', async () => {
  await runDesktop('C:/runtime', ['--invalid-option'], 'C:/workspace')
  const exit = fixture.menu.find(item => item.label === 'Exit')
  expect(exit?.click).toBeTypeOf('function')
  exit!.click!()
  await vi.waitFor(() => { expect(fixture.quit).toHaveBeenCalledWith(0) })
  expect(fixture.confirm).not.toHaveBeenCalled()
})
