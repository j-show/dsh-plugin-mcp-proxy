/** Initialize the local profile through public DSH APIs before service launch. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @param runtime - Verified distribution. @param home - Installation-owned profile home. */
export async function ensureLocalProfile(runtime: string, home: string): Promise<void> {
  const require = createRequire(join(runtime, 'resources/dsh/package.json'))
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href) as {
    initProfile(directory: string, bundles: readonly string[]): void
    resolveProfileDir(name: string, home: string): string
  }
  boot.initProfile(boot.resolveProfileDir('mcp-proxy', home), ['@j-show/mcp-proxy-runtime'])
}
