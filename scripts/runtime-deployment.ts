/** File materialization shared by runtime distribution builders. */
import { existsSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Remove pnpm's unrelated workspace hoists from this new, private deployment only. */
export async function pruneDeploymentWorkspaces(staging:string,excluded:ReadonlySet<string>):Promise<void>{
  const root=resolve(staging,'node_modules');await realDirectory(root)
  async function visit(directory:string):Promise<void>{
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const path=join(directory,entry.name),parent=dirname(path)
      const scope=basename(parent),name=scope.startsWith('@')?scope+'/'+entry.name:entry.name
      const packageParent=scope.startsWith('@')?dirname(parent):parent
      const metadata=await lstat(path)
      if(basename(packageParent)==='node_modules'&&excluded.has(name)){
        if(metadata.isSymbolicLink())await unlink(path)
        else if(metadata.isDirectory())await rm(path,{recursive:true,force:false})
        else throw new Error('Unexpected workspace deployment entry')
      }else if(metadata.isDirectory()&&!metadata.isSymbolicLink())await visit(path)
    }
  }
  await visit(root)
}

/**
 * @param staging - owned deployment directory.
 * @param sourceNodeModules - source installation dependencies.
 * @returns restored direct package names.
 */
export async function restoreDeploymentDependencies(staging: string, sourceNodeModules: string): Promise<string[]> {
  const root = resolve(staging, 'node_modules')
  await realDirectory(root)
  const manifest: unknown = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('dependencies' in manifest)
    || typeof manifest.dependencies !== 'object' || manifest.dependencies === null || Array.isArray(manifest.dependencies)) {
    throw new Error('Invalid deployment dependency manifest')
  }
  const names = Object.keys(manifest.dependencies).sort()
  if (names.some(name => !/^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name))) {
    throw new Error('Invalid deployment dependency name')
  }
  const restored: string[] = []
  for (const name of names) {
    const destination = join(root, name)
    if (dirname(destination) !== root) {
      await mkdir(dirname(destination), { recursive: true })
      await realDirectory(dirname(destination))
    }
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, name)
    if (!existsSync(source)) throw new Error(`Deployment dependency ${name} is absent from its source and payload`)
    await copyPackage(source, destination)
    restored.push(name)
  }
  return restored
}
/** @param staging - owned deployment directory. @returns after isolating symbolic and hard-linked package files. */
export async function materializeDeploymentLinks(staging: string): Promise<void> {
  const root = resolve(staging, 'node_modules')
  await realDirectory(root)
  for (;;) {
    const link = await findLink(root)
    if (link === undefined) break
    const child = relative(root, link)
    if (isAbsolute(child) || child === '..' || child.startsWith('..' + sep)) throw new Error('Deployment link escaped its payload')
    const segments = child.split(sep)
    const bin = segments.lastIndexOf('.bin')
    if (bin >= 0) {
      const directory = join(root, ...segments.slice(0, bin + 1))
      if ((await lstat(directory)).isSymbolicLink()) await unlink(directory)
      else await rm(directory, { recursive: true, force: true })
    } else {
      const source = await realpath(link)
      await unlink(link)
      await copyPackage(source, link)
    }
  }
  await detachHardLinks(root)
}

async function detachHardLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error('Deployment links changed during materialization')
    if (metadata.isDirectory()) await detachHardLinks(path)
    else if (metadata.isFile() && metadata.nlink > 1) {
      const temporary = await mkdtemp(join(directory, '.dsh-materialize-'))
      try {
        const copy = join(temporary, 'file')
        await copyFile(path, copy)
        await rename(copy, path)
      } finally { await rm(temporary, { recursive: true, force: true }) }
    }
  }
}

async function realDirectory(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('A real deployment dependency directory is required')
}

async function copyPackage(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true,
    filter: path => !relative(source,path).split(sep).includes('node_modules'),
  })
}

async function findLink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findLink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}
