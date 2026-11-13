/** Run tests with the same supported Windows runtime as the release build. */
import { join, resolve } from 'node:path'
import { prepareMcpBuildRuntime, mcpBuildEnvironment } from './mcp-build-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'

const root = resolve(import.meta.dirname, '..')
const executable = await prepareMcpBuildRuntime(root) ?? process.execPath
await runMcpBuildCommand(executable, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)],
  root, mcpBuildEnvironment(executable, process.env))
