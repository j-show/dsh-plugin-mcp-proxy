/** NSIS still has MAX_PATH constraints; use a temporary drive alias for owned build output. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
const execute = promisify(execFile)
export interface BuildDriveCommands { readonly list: () => Promise<string>; readonly mount: (drive: string, directory: string) => Promise<void>; readonly unmount: (drive: string) => Promise<void> }
const native: BuildDriveCommands = {
  list: async () => (await execute('subst', [], { windowsHide: true })).stdout,
  mount: async (drive, directory) => { await execute('subst', [drive, directory], { windowsHide: true }) },
  unmount: async drive => { await execute('subst', [drive, '/D'], { windowsHide: true }) },
}
/** Never replace another mapping; release only the alias we just created and still own. */
export async function withWindowsBuildDrive<T>(directory: string, build: (root: string) => Promise<T>, commands: BuildDriveCommands = native): Promise<T> {
  const target = resolve(directory)
  let drive: string | undefined
  for (const letter of ['Z', 'Y', 'X', 'W', 'V', 'U', 'T']) {
    try { await commands.mount(letter + ':', target); drive = letter + ':'; break } catch { /* Occupied drives are never replaced. */ }
  }
  if (!drive) throw new Error('NSIS needs an unused temporary drive letter between T: and Z:')
  try { return await build(drive + '\\') } finally {
    const row = (await commands.list()).split(/\r?\n/).find(line => line.toUpperCase().startsWith(drive!.toUpperCase() + '\\: => '))
    const mounted = row?.slice(row.indexOf(' => ') + 4).trim()
    if (!mounted || resolve(mounted).toLowerCase() !== target.toLowerCase()) throw new Error('Temporary build drive ownership changed; refusing to remove it')
    await commands.unmount(drive)
  }
}
