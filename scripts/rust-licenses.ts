/** Preserve notices from the actual Cargo dependency closure without exposing cache paths. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function writeRustLicenses(root: string, destination: string, target: string): Promise<void> {
  const output = await promisify(execFile)('cargo',['metadata','--locked','--format-version','1','--filter-platform',target,
    '--manifest-path',join(root,'packages/mcp-proxy/src-tauri/Cargo.toml')],{cwd:root,windowsHide:true,maxBuffer:16777216,timeout:300000})
  const metadata = JSON.parse(output.stdout) as { packages: Array<{name:string;version:string;source:string|null;license:string|null;manifest_path:string}> }
  const index: Array<{name:string;version:string;license:string|null;files:string[]}> = []
  await mkdir(destination,{recursive:true})
  for (const pkg of metadata.packages) {
    if (!pkg.source) continue
    const key = pkg.name + '-' + pkg.version
    if (!/^[A-Za-z0-9_.+-]+$/.test(key)) throw new Error('Invalid Cargo license entry')
    const source = dirname(pkg.manifest_path), names: string[] = []
    for (const file of await readdir(source,{withFileTypes:true})) {
      if (!file.isFile() || !/^(LICENSE|LICENCE|COPYING|NOTICE|UNLICENSE)(?:$|[._-])/i.test(file.name)) continue
      const path = key + '/' + file.name
      await mkdir(join(destination,key),{recursive:true})
      await writeFile(join(destination,path),await readFile(join(source,file.name)))
      names.push(path)
    }
    index.push({name:pkg.name,version:pkg.version,license:pkg.license,files:names})
  }
  await writeFile(join(destination,'index.json'),JSON.stringify(index,null,2)+'\n')
}
