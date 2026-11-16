/** Detached startup through the verified dsh profile with private IPC readiness. */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { requestLocalStatus, requestLocalStop } from './control.ts'
import { linuxProcessGroupHasLiveMembers } from './process-groups.ts'
import { settleBackgroundOwner } from './background-owner.ts'

/** Fully resolved profile launcher and lifecycle budgets. */
export interface BackgroundServiceSpec {
  readonly node: string
  readonly cli: string
  readonly home: string
  readonly cwd: string
  readonly profile: string
  readonly profileDir: string
  readonly settings: string
  readonly address: string
  readonly controlTimeoutMs: number
  readonly startupTimeoutMs: number
  readonly pollIntervalMs: number
  readonly shutdownTimeoutMs: number
}
/**
 * Start the fixed dsh profile and wait for its own readiness acknowledgement.
 * @param spec - fixed dsh launcher and private control address.
 * @param signal - initiating startup lifetime; ownership transfers only after readiness.
 * @returns the ready detached process; failed startup stops only the child it created.
 */
export async function startBackgroundService(spec: BackgroundServiceSpec, signal: AbortSignal): Promise<{ readonly pid: number }> {
  signal.throwIfAborted()
  const deadline = new AbortController()
  const combined = AbortSignal.any([signal, deadline.signal])
  const timer = setTimeout(() => { deadline.abort() }, spec.startupTimeoutMs)
  let child: ChildProcess | undefined
  let finished = false
  let completion: Promise<void> | undefined
  try {
    const existing = await requestLocalStatus(spec.address, spec.controlTimeoutMs, combined).catch((_error: unknown) => undefined)
    combined.throwIfAborted()
    if (existing !== undefined) throw new Error('Local MCP service is already running')
    const log = await openLog(join(spec.profileDir, 'mcp-proxy.log'))
    try {
      child = spawn(spec.node, [spec.cli, '--profile', spec.profile, '--config', spec.settings], {
        cwd: spec.cwd, env: { ...process.env, DSH_HOME: spec.home }, detached: true, windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      })
      const owned = child
      completion = new Promise<void>((resolve) => {
        owned.once('exit', () => { finished = true; resolve() })
        owned.on('error', () => {
          // A failed spawn has no process to wait for; later exit still owns a running child.
          if (owned.pid === undefined) { finished = true; resolve() }
        })
      })
      await once(child, 'spawn')
    } finally { await log.close() }
    const pid = child.pid
    if (pid === undefined) throw new Error('Local service has no process identity')
    for (;;) {
      combined.throwIfAborted()
      if (finished) throw new Error('Local service exited before readiness')
      const status = await requestLocalStatus(spec.address, spec.controlTimeoutMs, combined).catch((_error: unknown) => undefined)
      combined.throwIfAborted()
      if (status !== undefined) {
        if (status.pid !== pid) throw new Error('Local service address belongs to another process')
        if (status.ready && !finished) { child.unref(); return { pid } }
      }
      await delay(spec.pollIntervalMs, undefined, { signal: combined })
    }
  } catch (error) {
    if (child?.pid !== undefined && completion !== undefined) {
      const owned = child
      const until = performance.now() + spec.shutdownTimeoutMs
      let fallbackSignal: 'SIGTERM' | undefined
      if (!finished) {
        try { await requestLocalStop(spec.address, Math.min(spec.controlTimeoutMs, spec.shutdownTimeoutMs), child.pid) } catch (_error) {
          // No matching responsive control owner; the service's process containment owns descendants.
          // Settle owns the presence check and all signal-permission reconciliation.
          fallbackSignal = 'SIGTERM'
        }
      }
      await settleBackgroundOwner({ root: completion, rootExited: () => finished,
        alive: () => process.platform === 'win32' ? !finished : groupAlive(owned.pid),
        signal: signal => signalOwnedChild(owned, signal),
      }, { graceMs: Math.max(0, until - performance.now()), reapMs: spec.shutdownTimeoutMs, pollMs: spec.pollIntervalMs, fallbackSignal })
    }
    if (child === undefined && error instanceof Error && error.message === 'Local MCP service is already running') throw error
    throw new Error('Local MCP background startup failed')
  } finally { clearTimeout(timer) }
}

function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try { process.kill(-pid, 0) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
  return process.platform !== 'linux' || linuxProcessGroupHasLiveMembers(pid) !== false
}

function signalOwnedChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') { child.kill(signal); return }
  try { process.kill(-child.pid, signal) } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    child.kill(signal)
  }
}

async function openLog(filename: string) {
  let previous
  try { previous = await lstat(filename) } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  if (previous !== undefined && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('Private service log required')
  const handle = await open(filename, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const held = await handle.stat({ bigint: true })
    const current = await lstat(filename, { bigint: true })
    const uid = process.getuid?.()
    if (current.isSymbolicLink() || !held.isFile() || current.ino !== held.ino || current.dev !== held.dev
      || (process.platform !== 'win32' && (uid === undefined || held.uid !== BigInt(uid) || (held.mode & 0o077n) !== 0n))) {
      throw new Error('Private service log required')
    }
    return handle
  } catch (error) { await handle.close(); throw error }
}
