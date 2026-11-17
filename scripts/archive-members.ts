/** Inspect a generated npm archive without extracting it. */
import { execFileSync } from 'node:child_process'
import {nativeTar} from './run-mcp-build-command.ts'
export function tarballFiles(archive:string):string[]{return execFileSync(nativeTar(),['-tzf',archive],{encoding:'utf8',windowsHide:true,maxBuffer:4194304}).split(/\r?\n/).filter(Boolean)}
