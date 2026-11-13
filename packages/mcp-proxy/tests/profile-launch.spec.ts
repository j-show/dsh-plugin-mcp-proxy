import { join } from 'node:path'
import { expect, it } from 'vitest'
import { electronProfileLaunch } from '../src/profile-launch.ts'

it('does not inherit another Electron application crash registration pipe', () => {
  const parent = { CHROME_CRASHPAD_PIPE_NAME: 'unrelated-pipe', CHROME_CRASHPAD_SERVER_URL: 'unrelated-url', KEEP: 'value' }
  const launched = electronProfileLaunch('C:/runtime', [], parent)
  expect(launched.env.CHROME_CRASHPAD_PIPE_NAME).toBeUndefined()
  expect(launched.env.CHROME_CRASHPAD_SERVER_URL).toBeUndefined()
  expect(parent.CHROME_CRASHPAD_PIPE_NAME).toBe('unrelated-pipe')
})

it('uses the cached Electron runtime for the fixed dsh profile without changing input arguments or environment', () => {
  const args = ['--config', 'C:/local files/settings.json', '--associate', 'mcp-proxy://associate/' + 'a'.repeat(43)]
  const env = { DSH_HOME: 'C:/local state', CUSTOM: 'kept' }
  const launch = electronProfileLaunch('C:/runtime cache', args, env)
  expect(launch).toEqual({ command: join('C:/runtime cache', 'mcp-proxy.exe'),
    args: [join('C:/runtime cache', 'resources/dsh/lib/bin.js'), '--profile', 'mcp-proxy', ...args],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  })
  expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  expect(args).toHaveLength(4)
})
