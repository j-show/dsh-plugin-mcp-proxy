/** Package scripts share one Node 22 bootstrap and shell-free dispatch. */
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { relaunchBuildRuntime, mcpBuildEnvironment } from './mcp-build-runtime.ts'
import { runMcpBuildCommand } from './run-mcp-build-command.ts'

const root = resolve(import.meta.dirname,'..')
if (!await relaunchBuildRuntime(root)) {
  const [task,...args] = process.argv.slice(2)
  if (task === 'typecheck') await runMcpBuildCommand(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'-b',join(root,'tsconfig.json')],root)
  else if (task === 'rust-test') await runMcpBuildCommand('cargo',['test','--locked','--manifest-path',join(root,'packages/mcp-proxy/src-tauri/Cargo.toml')],root)
  else if (task === 'test') await runMcpBuildCommand(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run',...args],root,mcpBuildEnvironment(process.execPath,process.env))
  else {
    const modules: Record<string,string> = { shared:'build-shared.ts', app:'build-app.ts', plugin:'build.ts', dev:'dev.ts', product:'test-product.ts', installer:'test-installer.ts', browser:'test-browser.ts', verify:'verify.ts' }
    const file = task && modules[task]
    if (!file) throw new Error('Choose a documented package script')
    const path = join(root,'scripts',file)
    process.argv = [process.execPath,path,...(task === 'plugin' ? ['plugin',...args] : args)]
    await import(pathToFileURL(path).href)
  }
}
