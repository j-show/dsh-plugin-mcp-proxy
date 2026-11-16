/** Explicit native build plans. Never silently omit a requested target. */
export interface AppTarget { id: string; platform: NodeJS.Platform; arch: 'ia32' | 'x64' | 'arm64'; triple: string; bundle: 'nsis' | 'dmg' | 'deb' }
export const appTargets: Readonly<Record<string, AppTarget>> = {
  'win-32': { id: 'win-32', platform: 'win32', arch: 'ia32', triple: 'i686-pc-windows-msvc', bundle: 'nsis' },
  'win-64': { id: 'win-64', platform: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc', bundle: 'nsis' },
  'mac-intel': { id: 'mac-intel', platform: 'darwin', arch: 'x64', triple: 'x86_64-apple-darwin', bundle: 'dmg' },
  'mac-arm': { id: 'mac-arm', platform: 'darwin', arch: 'arm64', triple: 'aarch64-apple-darwin', bundle: 'dmg' },
  linux: { id: 'linux', platform: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-gnu', bundle: 'deb' },
}
export function appBuildPlan(name: string, platform: NodeJS.Platform): AppTarget[] {
  if (name === 'host') name = platform === 'win32' ? (process.arch === 'ia32' ? 'win-32' : 'win-64')
    : platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm' : 'mac-intel') : 'linux'
  const ids = name === 'win' ? ['win-32', 'win-64'] : name === 'mac' ? ['mac-intel', 'mac-arm'] : [name]
  const targets = ids.map(id => appTargets[id])
  if (targets.some(target => !target)) throw new Error('Unknown application build target')
  for (const target of targets) if (target!.platform !== platform) throw new Error(`${target!.id} requires a ${target!.platform} build host`)
  return targets as AppTarget[]
}
