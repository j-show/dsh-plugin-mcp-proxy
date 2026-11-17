/** DSH browser module-table bundle with locally compiled CSS Modules. */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build } from 'tsdown'
import { transform } from 'lightningcss'

/** @param root - Repository root. @returns After the plugin's self-contained browser artifact is emitted. */
export async function buildBrowserClient(root: string, development = false): Promise<void> {
  const directory = join(root, 'packages/dsh-plugin/modules/ui')
  const id = '@jshow/dsh-plugin-mcp-proxy'
  const externals = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit'])
  await build({ config: false, cwd: directory, entry: ['src/client/index.ts'], outDir: '../../lib', format: ['cjs'],
    platform: 'browser', target: 'es2024', dts: false, sourcemap: development, clean: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    deps: { neverBundle: source => externals.has(source), alwaysBundle: source => !externals.has(source) },
    plugins: [{ name: 'plugin-css-modules',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css')) return null
        if (importer === undefined) throw new Error('CSS module requires an importer')
        return '\0mcp-css:' + resolve(dirname(importer), source) + '.mjs'
      },
      async load(id) {
        if (!id.startsWith('\0mcp-css:')) return null
        const filename = id.slice('\0mcp-css:'.length, -4)
        const result = transform({ filename, code: await readFile(filename), cssModules: true, minify: true })
        const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
        const css = JSON.stringify(result.code.toString())
        const key = JSON.stringify('mcp-proxy/' + filename.split(/[\\/]/).at(-1))
        return `const key=${key};if(typeof document!=='undefined'&&!document.querySelector('style[data-mcp-css="'+key+'"]')){const s=document.createElement('style');s.dataset.mcpCss=key;s.textContent=${css};document.head.appendChild(s)}export default ${JSON.stringify(classes)};`
      },
    }],
    outputOptions: { entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:(require)=>{`,
      intro: 'var module={exports:{}};var exports=module.exports;', footer: 'return module.exports;}});' },
  })
}
