/** Preserve the caller directory before the pinned portable bootstrap changes it. */
import { createRequire } from 'node:module'

/** @param source - generated NSIS portable source. @returns source with invocation-directory capture. */
export function capturePortableWorkingDirectory(source: string): string {
  const normalized = source.replaceAll('\r\n', '\n')
  const anchor = 'Function .onInit\n'
  if (normalized.split(anchor).length !== 2 || normalized.includes('MCP_PROXY_INVOKING_CWD')) {
    throw new Error('Electron portable initialization template changed')
  }
  const capture = [
    '  Push $0', '  Push $1',
    "  System::Call 'Kernel32::GetCurrentDirectory(i ${NSIS_MAX_STRLEN}, t .r0)i.r1'",
    '  ${If} $1 == 0', '    SetErrorLevel 1', '    Quit', '  ${EndIf}',
    '  ${If} $1 >= ${NSIS_MAX_STRLEN}', '    SetErrorLevel 1', '    Quit', '  ${EndIf}',
    "  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i (\"MCP_PROXY_INVOKING_CWD\", \"$0\").r1'",
    "  System::Call 'Kernel32::SetEnvironmentVariable(t, p)i (\"CHROME_CRASHPAD_PIPE_NAME\", 0).r1'",
    "  System::Call 'Kernel32::SetEnvironmentVariable(t, p)i (\"CHROME_CRASHPAD_SERVER_URL\", 0).r1'",
    '  ReadEnvStr $0 "LOCALAPPDATA"',
    '  ${If} $0 == ""', '    SetErrorLevel 1', '    Quit', '  ${EndIf}',
    '  CreateDirectory "$0\\McpProxy\\bootstrap"',
    "  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i (\"ELECTRON_LOG_FILE\", \"$0\\McpProxy\\bootstrap\\electron.log\").r1'",
    "  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i (\"ELECTRON_ENABLE_LOGGING\", \"1\").r1'",
    '  Pop $1', '  Pop $0', '',
  ].join('\n')
  return normalized.replace(anchor, anchor + capture)
}

interface PortableCompiler {
  readonly name: string
  executeMakensis(defines: unknown, commands: unknown, source: string, ...options: unknown[]): Promise<void>
}

/** Install the build-only adapter for electron-builder's pinned portable compiler. */
export function installPortableWorkingDirectoryCapture(): void {
  const local = createRequire(import.meta.url)
  const require = createRequire(local.resolve('electron-builder'))
  if (require('app-builder-lib/package.json').version !== '26.15.3') throw new Error('Unsupported Electron portable build-tool version')
  require('app-builder-lib')
  // The pinned builder exposes no public hook for portable.nsi initialization.
  const prototype = require('app-builder-lib/out/targets/nsis/NsisTarget.js').NsisTarget.prototype as PortableCompiler
  const compile = prototype.executeMakensis
  if (typeof compile !== 'function') throw new Error('Electron portable compiler method changed')
  prototype.executeMakensis = function (defines, commands, source, ...options) {
    return compile.call(this, defines, commands, this.name === 'portable' ? capturePortableWorkingDirectory(source) : source, ...options)
  }
}
