import { expect, it, onTestFinished } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRuntimeInventory, verifyDesktopRuntime } from './runtime-inventory.ts'

it('qualifies the exact runtime without repairing altered or extra files', async () => {
  const root = await mkdtemp(join(tmpdir(),'mcp-inventory-'))
  onTestFinished(() => rm(root,{recursive:true,force:true}))
  const resources = join(root,'resources'); await mkdir(resources)
  await writeFile(join(resources,'runtime.bin'),'original')
  await writeRuntimeInventory(resources,'win32','x64','22.23.5')
  await expect(verifyDesktopRuntime(root)).resolves.toBeUndefined()
  await writeFile(join(resources,'runtime.bin'),'changed')
  await expect(verifyDesktopRuntime(root)).rejects.toThrow('hash mismatch')
  expect(await readFile(join(resources,'runtime.bin'),'utf8')).toBe('changed')
  await writeFile(join(resources,'runtime.bin'),'original')
  await writeFile(join(resources,'unexpected.node'),'extra')
  await expect(verifyDesktopRuntime(root)).rejects.toThrow('file set')
})
