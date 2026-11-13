/** Process-held Windows crash protection for the dedicated local service application. */
import { extendWin32ProcessBindings, type NativePtr } from '@deepseek-ai/dsh-win32-process'
import { holdCurrentProcessJob, type CurrentProcessJob } from './windows-job.ts'

/**
 * Keep owned Windows MCP descendants in the service lifetime Job.
 * @returns a non-inheritable Job handle owned by this service process before any MCP starts.
 */
export function holdWindowsServiceJob(): CurrentProcessJob {
  const api = extendWin32ProcessBindings<{ getCurrentProcess(): NativePtr }>(({ kernel32, bind }) => ({
    getCurrentProcess: bind(kernel32, 'GetCurrentProcess', 'void *', []) as () => NativePtr,
  }))
  return holdCurrentProcessJob(api, api.getCurrentProcess())
}
