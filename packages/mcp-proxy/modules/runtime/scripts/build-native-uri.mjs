/** Build the Windows GUI URI bridge; this script never registers or launches it. */
import { compileWindowsUriHelper } from '../src/native-builder.ts'
import { fileURLToPath } from 'node:url'

await compileWindowsUriHelper(fileURLToPath(new URL('../../../lib/', import.meta.url)), 30000)
