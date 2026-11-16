import { expect, it, vi } from 'vitest'
import { desktopDataDirectory, DesktopHost } from '../src/desktop-host.ts'
import { join } from 'node:path'
import {tmpdir} from 'node:os'
import type * as DesktopApi from '@j-show/mcp-proxy-runtime/desktop'
import {parseLocalManagementReply} from '@j-show/mcp-proxy-local/management'

it('never stops an existing service rejected during desktop configuration ownership checks', async () => {
  const root = join(tmpdir(),'mcp-host-owner-fixture'), settings = join(root,'ours.json'), stop = vi.fn(),emit=vi.fn()
  const api = { ManagedSettingsStore:{open:async()=>({})},machineControlAddress:async()=> 'fixture-control',
    requestLocalStatus:async()=>({pid:1999999999,ready:true}),requestLocalStop:stop,parseLocalManagementReply,
    requestLocalManagement:async()=>({ok:true,snapshot:{version:2,pid:1999999999,directory:root,settingsFile:join(root,'other.json'),services:[],servers:[]}}),
  } as unknown as typeof DesktopApi
  const host = new DesktopHost({resources:root,executable:join(root,'app'),cwd:root,documents:root,args:['--config',settings],locale:'en',registerProtocol:false},emit,
    {loadApi:async()=>api,initializeProfile:async()=>{},applyPresets:async()=>{}})
  await expect(host.start()).rejects.toThrow('Another configuration')
  await expect(host.close()).resolves.toBeUndefined()
  expect(stop).not.toHaveBeenCalled()
  expect(emit.mock.calls.some(call=>call[0]==='owner')).toBe(false)
})
it('preserves Windows data locations and uses per-user locations on macOS and Linux', () => {
  expect(desktopDataDirectory('win32', { LOCALAPPDATA: 'C:/Local' }, 'C:/Home')).toMatch(/McpProxy$/)
  expect(() => desktopDataDirectory('win32', {}, 'C:/Home')).toThrow('LOCALAPPDATA')
  expect(desktopDataDirectory('darwin', {}, '/Users/test')).toMatch(/Library[\\/]Application Support[\\/]McpProxy$/)
  expect(desktopDataDirectory('linux', { XDG_DATA_HOME: '/private/data' }, '/home/test')).toMatch(/private[\\/]data[\\/]mcp-proxy$/)
})
