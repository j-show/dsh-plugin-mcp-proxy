import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { withWindowsBuildDrive } from './windows-build-drive.ts'

it('does not replace occupied drives and removes its owned alias even when a build fails', async () => {
  const removed: string[] = []
  const directory = resolve('.artifacts/long-build-path')
  await expect(withWindowsBuildDrive(directory, async root => { expect(root).toBe('Y:\\'); throw new Error('build failed') }, {
    mount: async drive => { if (drive === 'Z:') throw new Error('occupied') },
    list: async () => `Z:\\: => other\nY:\\: => ${directory}\n`,
    unmount: async drive => { removed.push(drive) },
  })).rejects.toThrow('build failed')
  expect(removed).toEqual(['Y:'])
})

it('does not unmount an alias whose ownership changed', async () => {
  const removed: string[] = []
  await expect(withWindowsBuildDrive(resolve('.artifacts/build'), async () => 1, {
    mount: async () => {}, list: async () => 'Z:\\: => C:\\other\n', unmount: async drive => { removed.push(drive) },
  })).rejects.toThrow('ownership changed')
  expect(removed).toEqual([])
})
