import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const modules = JSON.parse(readFileSync(new URL('./scripts/modules.json', import.meta.url), 'utf8')) as Array<{name:string;directory:string}>
const aliases = modules.flatMap(m => [
 { find: new RegExp('^' + m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/src/(.+)$'), replacement: resolve(m.directory, 'src/$1') },
 { find: m.name + '/desktop', replacement: resolve(m.directory, 'src/desktop.ts') },
 { find: m.name + '/startup', replacement: resolve(m.directory, 'src/startup.ts') },
 { find: m.name + '/activation', replacement: resolve(m.directory, 'src/activation.ts') },
 { find: m.name + '/management', replacement: resolve(m.directory, 'src/management.ts') },
 { find: m.name, replacement: resolve(m.directory, 'src/index.ts') },
])
export default defineConfig({ resolve: { alias: aliases }, test: { include: ['packages/**/tests/**/*.spec.ts','packages/**/tests/**/*.spec.tsx','scripts/**/*.spec.ts'], testTimeout:30000, hookTimeout:30000, maxWorkers:4,
  server: { deps: { inline: [/@deepseek-ai\/dsh-client-ui-primitives/] } },
} })
