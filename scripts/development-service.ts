/** Development uses the same private address and conservative idle policy as product execution. */
import {assertProductServiceIdle} from './product-service.ts'

async function runtimeAddress():Promise<string>{
  const runtime=await import(new URL('../packages/mcp-proxy/modules/runtime/src/control.ts',import.meta.url).href) as {machineControlAddress:()=>Promise<string>}
  return runtime.machineControlAddress()
}
export async function assertDevelopmentServiceIdle(address:()=>Promise<string>=runtimeAddress):Promise<void>{
  await assertProductServiceIdle(await address())
}
