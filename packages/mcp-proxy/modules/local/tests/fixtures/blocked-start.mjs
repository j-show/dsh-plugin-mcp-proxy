/** A real external MCP fixture whose startup can be released by its test owner. */
import { access, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const [entered, release] = process.argv.slice(2)
await writeFile(entered, 'started')
while (true) {
  try { await access(release); break } catch (_error) {
    // The test has not yet released initialization.
  }
  await setTimeout(10)
}
await import('./files.mjs')
