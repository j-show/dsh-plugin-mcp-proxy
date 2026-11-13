import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { capturePortableWorkingDirectory } from '../scripts/portable-cwd.ts'

it('captures the invocation directory in the actual pinned portable template before extraction changes it', async () => {
  const require = createRequire(new URL('../package.json', import.meta.url))
  const template = await readFile(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/portable.nsi'), 'utf8')
  const script = capturePortableWorkingDirectory(template)
  expect(script.indexOf('MCP_PROXY_INVOKING_CWD')).toBeGreaterThan(script.indexOf('Function .onInit'))
  expect(script.indexOf('MCP_PROXY_INVOKING_CWD')).toBeLessThan(script.indexOf('SetOutPath $INSTDIR'))
  expect(script).toContain('Pop $1\n  Pop $0')
  expect(script).toContain('ExecWait')
  expect(script).toContain('ELECTRON_LOG_FILE')
  expect(script).toContain('ELECTRON_ENABLE_LOGGING')
  expect(script.indexOf('ELECTRON_LOG_FILE')).toBeLessThan(script.indexOf('ExecWait'))
  expect(script).toContain('CreateDirectory "$0\\McpProxy\\bootstrap"')
})

it('refuses an absent, duplicated or already-modified initialization function', () => {
  for (const source of ['', 'Function .onInit\nFunction .onInit\n', 'Function .onInit\nMCP_PROXY_INVOKING_CWD']) {
    expect(() => capturePortableWorkingDirectory(source)).toThrow('template changed')
  }
})
