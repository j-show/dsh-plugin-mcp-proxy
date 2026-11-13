/** Local-only association control and the machine singleton listener. */
import { createConnection, createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { lstat, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireUnixControlLease } from './unix-control-lease.ts'

const transaction = /^[A-Za-z0-9_-]{43}$/

/**
 * Resolve the machine-wide private control address.
 * @returns this machine's fixed local control address, with a private Unix parent directory.
 */
export async function machineControlAddress(): Promise<string> {
  if (process.platform === 'win32') return '\\\\.\\pipe\\dsh-mcp-proxy'
  const directory = '/tmp/dsh-mcp-proxy'
  try {
    try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('Private local control directory required')
    }
    return join(directory, 'service.sock')
  } catch (_error) {
    throw new Error('Local mcp-proxy control directory unavailable')
  }
}

function deadline(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Invalid local control deadline')
}

async function line(socket: Socket, maxBytes: number): Promise<string> {
  let value = Buffer.alloc(0)
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    const bytes = chunk as Buffer
    if (value.length + bytes.length > maxBytes) throw new Error('Invalid local control frame')
    value = Buffer.concat([value, bytes])
    if (value.includes(10)) return value.toString('utf8')
  }
  throw new Error('Local control request closed')
}

async function response(socket: Socket, value: string): Promise<void> {
  if (socket.destroyed) return
  const closed = new Promise<void>((resolve) => { socket.once('close', resolve) })
  socket.end(value, () => { socket.destroy() })
  await closed
}
/** Deployment limits for concurrent local requests and their deadlines. */
export interface ControlOptions { readonly timeoutMs: number; readonly maxConnections: number }
/** Owned control listener; shutdown waits for accepted forwarding work. */
export interface LocalControlServer { close(): Promise<void> }
/** Bounded desktop management endpoint on the same owner-only control listener. */
export interface LocalControlManagement {
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly handle: (request: unknown) => Promise<unknown>
}

/**
 * Exchange one bounded management command with the local service owner.
 * @param address - private local owner.
 * @param request - JSON management command.
 * @param timeoutMs - operation budget.
 * @param maxResponseBytes - response cap.
 * @returns validated response envelope value.
 */
export async function requestLocalManagement(address: string, request: unknown, timeoutMs: number,
  maxResponseBytes: number): Promise<unknown> {
  deadline(maxResponseBytes)
  const text = await exchange(address, 'MANAGE ' + JSON.stringify(request) + '\n', timeoutMs, undefined, maxResponseBytes)
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== true || !('value' in value)) {
      throw new Error('Invalid management response')
    }
    return value.value
  } catch (_error) {
    throw new Error('Local MCP management unavailable')
  }
}
/** The process owning this private control address and its catalog-acknowledged readiness. */
export interface LocalControlStatus { readonly pid: number; readonly ready: boolean }
/**
 * Read the local service process identity and readiness.
 * @param address - private local control address.
 * @param timeoutMs - response deadline.
 * @param signal - optional initiating operation cancellation.
 * @returns the current local owner status.
 */
export async function requestLocalStatus(address: string, timeoutMs: number, signal?: AbortSignal): Promise<LocalControlStatus> {
  const text = await exchange(address, 'STATUS\n', timeoutMs, signal)
  const match = /^PID ([1-9][0-9]{0,9}) (ready|starting)\n$/.exec(text)
  if (match === null) throw new Error('Local mcp-proxy service unavailable')
  return { pid: Number(match[1]), ready: match[2] === 'ready' }
}
/**
 * Extract the transaction from a validated legacy activation URI.
 * @param uri - OS activation URI.
 * @returns opaque association transaction only.
 */
export function associationFromUri(uri: string): string {
  try {
    const url = new URL(uri)
    const id = url.pathname.slice(1)
    if (url.protocol !== 'mcp-proxy:' || url.host !== 'associate' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' + id || !transaction.test(id)) throw new Error('Invalid activation')
    return id
  } catch (_error) {
    // URI contents may include an association secret; diagnostics never repeat them.
    throw new Error('Invalid mcp-proxy association URI')
  }
}
/**
 * Own the singleton control listener until disposal.
 * @param address - local pipe or Unix socket address.
 * @param options - deployment request budgets.
 * @param forward - authenticated remote-channel writer, never a tool executor.
 * @param stop - optional launcher-owned shutdown request, invoked after acknowledgement closes.
 * @param ready - optional status owner; absence disables status requests.
 * @returns owned singleton listener; an occupied address rejects.
 * @param management - Optional bounded desktop management handler.
 */
export async function listenLocalControl(
  address: string, options: ControlOptions, forward: (requestId: string) => Promise<void>, stop?: () => void, ready?: () => boolean,
  management?: LocalControlManagement,
): Promise<LocalControlServer> {
  deadline(options.timeoutMs)
  if (management !== undefined) { deadline(management.maxRequestBytes); deadline(management.maxResponseBytes) }
  if (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1) throw new Error('Invalid local control capacity')
  const spec = { ...options }
  const sockets = new Set<Socket>()
  const work = new Set<Promise<void>>()
  let closing = false
  let closed: Promise<void> | undefined
  const serve = async (socket: Socket): Promise<void> => {
    const timer = setTimeout(() => { socket.destroy() }, spec.timeoutMs)
    timer.unref()
    try {
      const frame = await line(socket, management?.maxRequestBytes ?? 44)
      if (closing) throw new Error('Local control is closing')
      if (frame.startsWith('MANAGE ') && management !== undefined) {
        const value = await management.handle(JSON.parse(frame.slice(7)) as unknown)
        const result = JSON.stringify({ ok: true, value }) + '\n'
        if (Buffer.byteLength(result) > management.maxResponseBytes) throw new Error('Local management response limit exceeded')
        await response(socket, result)
        return
      }
      if (frame === 'STATUS\n' && ready !== undefined) {
        await response(socket, `PID ${process.pid} ${ready() ? 'ready' : 'starting'}\n`)
        return
      }
      const target = /^STOP ([1-9][0-9]{0,9})\n$/.exec(frame)
      if ((frame === 'STOP\n' || (target !== null && Number(target[1]) === process.pid)) && stop !== undefined) {
        await response(socket, 'OK\n')
        stop()
        return
      }
      if (frame.length !== 44 || frame[43] !== '\n' || !transaction.test(frame.slice(0, 43))) throw new Error('Invalid local control frame')
      await forward(frame.slice(0, 43))
      await response(socket, 'OK\n')
    } catch (_error) {
      // Local peers receive no parser, transport or remote credential details.
      await response(socket, 'ERROR\n')
    } finally { clearTimeout(timer); socket.destroy(); sockets.delete(socket) }
  }
  const server = createServer((socket) => {
    socket.on('error', () => { /* The request reader and shutdown owner contain socket failures. */ })
    if (closing || work.size >= spec.maxConnections) { socket.destroy(); return }
    sockets.add(socket)
    const task = serve(socket)
    work.add(task)
    void task.then(() => { work.delete(task) })
  })
  const lease = process.platform === 'win32' ? undefined : await acquireUnixControlLease(address + '.owner')
  try {
    if (lease !== undefined) await retireUnixSocket(address, spec.timeoutMs)
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => { reject(new Error('Local mcp-proxy service is already running or its control address is unavailable')) }
      server.once('error', failed)
      server.listen({ path: address }, () => { server.off('error', failed); resolve() })
    })
  } catch (error) { await lease?.release(); throw error }
  server.on('error', () => { /* Shutdown remains owned by the returned listener. */ })
  return { close() {
    return closed ??= (async () => {
      closing = true
      const stopped = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      for (const socket of sockets) socket.destroy()
      try { await Promise.all(work); await stopped } finally { await lease?.release() }
    })()
  } }
}

async function retireUnixSocket(address: string, timeoutMs: number): Promise<void> {
  let entry
  try { entry = await lstat(address, { bigint: true }) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  const uid = process.getuid?.()
  if (!entry.isSocket() || entry.isSymbolicLink() || uid === undefined || entry.uid !== BigInt(uid)) {
    throw new Error('Private Unix control socket required')
  }
  const socket = createConnection({ path: address })
  const closed = new Promise<void>((resolve) => { socket.once('close', resolve) })
  const timer = setTimeout(() => { socket.destroy(new Error('Unix control probe expired')) }, timeoutMs)
  timer.unref()
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => { reject(new Error('Local mcp-proxy control address is already active')) })
      socket.once('error', (error) => {
        if ('code' in error && error.code === 'ECONNREFUSED') resolve()
        else reject(new Error('Unix control socket unavailable'))
      })
    })
  } finally { clearTimeout(timer); socket.destroy(); await closed }
  const current = await lstat(address, { bigint: true })
  if (current.isSymbolicLink() || current.ino !== entry.ino || current.dev !== entry.dev) throw new Error('Unix control socket changed')
  await unlink(address)
}
/**
 * Forward a browser transaction to the existing local service.
 * @param address - local pipe or Unix socket address.
 * @param requestId - opaque browser transaction.
 * @param timeoutMs - bounded request deadline.
 * @returns acknowledgement of forwarding, not server association confirmation.
 */
export async function forwardLocalAssociation(address: string, requestId: string, timeoutMs: number): Promise<void> {
  if (!transaction.test(requestId)) throw new Error('Invalid mcp-proxy association transaction')
  if (await exchange(address, requestId + '\n', timeoutMs) !== 'OK\n') throw new Error('Local mcp-proxy service unavailable')
}

async function exchange(address: string, request: string, timeoutMs: number, signal?: AbortSignal, maxResponseBytes = 32): Promise<string> {
  deadline(timeoutMs)
  signal?.throwIfAborted()
  const socket = createConnection({ path: address })
  const abort = (): void => { socket.destroy() }
  signal?.addEventListener('abort', abort, { once: true })
  const closed = new Promise<void>((resolve) => { socket.once('close', resolve) })
  const timer = setTimeout(() => { socket.destroy() }, timeoutMs)
  timer.unref()
  socket.on('error', () => { /* The connect/read promises return a fixed availability error. */ })
  try {
    await Promise.race([
      once(socket, 'connect'),
      closed.then(() => { throw new Error('Local control closed before connection') }),
    ])
    socket.write(request)
    return await line(socket, maxResponseBytes)
  } catch (_error) {
    throw new Error('Local mcp-proxy service unavailable')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); await closed }
}

/**
 * Request shutdown from the selected local service process.
 * @param address - machine control address.
 * @param timeoutMs - acknowledgement deadline.
 * @param expectedPid - optional exact owner; a replacement process rejects the request.
 * @returns acknowledgement of a stop request, before shutdown finishes.
 */
export async function requestLocalStop(address: string, timeoutMs: number, expectedPid?: number): Promise<void> {
  if (expectedPid !== undefined && (!Number.isSafeInteger(expectedPid) || expectedPid < 1 || expectedPid > 9999999999)) {
    throw new Error('Invalid local service process identity')
  }
  const frame = expectedPid === undefined ? 'STOP\n' : `STOP ${expectedPid}\n`
  if (await exchange(address, frame, timeoutMs) !== 'OK\n') throw new Error('Local mcp-proxy service unavailable')
}
