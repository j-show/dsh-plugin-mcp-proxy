/** Attach a ready local MCP pool to its authenticated proxy connection. */
import { ProxyChannel, type AuthenticatedProxy, type ChannelOptions, type ProxyFrame, type proveProxyIdentity } from '@jshow/app-mcp-proxy/protocol'
import type { LocalMcpPool } from './pool.ts'
import type { LocalInvocationRoutes, LocalDshOwner } from './routing.ts'
type Catalog = Extract<ProxyFrame, { kind: 'catalog' }>
/** Shared-pool ownership and version lookup for a specific DSH channel. */
export interface LocalProxyScope {
  readonly owner: LocalDshOwner
  readonly routes: LocalInvocationRoutes
  readonly catalog: (revision: Catalog['revision']) => Catalog | undefined
  readonly retired?: (service: string) => void
}
/**
 * Install local execution synchronously in the identity handshake's ready callback.
 * @param socket - authenticated socket being transferred by the handshake owner.
 * @param peer - verified connection generation for that socket.
 * @param pool - ready local clients; the caller retains ownership of pool shutdown.
 * @param catalog - complete pool catalog pinned for this attachment.
 * @param limits - explicit aggregation channel limits.
 * @param scope - optional shared-pool routing and catalog owner.
 * @returns an invocation channel; close it before closing its separately owned pool.
 */
export function attachLocalProxy(
  socket: Parameters<typeof proveProxyIdentity>[0], peer: AuthenticatedProxy, pool: LocalMcpPool, catalog: Catalog,
  limits: Omit<ChannelOptions, 'generation' | 'onInvoke'>,
  scope?: LocalProxyScope,
): ProxyChannel {
  const pinned = structuredClone(catalog)
  return new ProxyChannel(socket, { ...limits, generation: peer.generation, onInvoke: async (frame, signal) => {
    const selected = scope === undefined ? pinned : scope.catalog(frame.revision)
    const tool = selected?.tools.find(tool => tool.service === frame.service && tool.name === frame.name)
    if (selected?.revision !== frame.revision || tool === undefined) {
      throw new Error('Local MCP invocation does not match the pinned catalog')
    }
    const incarnation = selected.services.find(service => service.service === frame.service)?.incarnation
    const assertClient = (): void => {
      if (!pool.matchesTool(tool, incarnation)) {
        scope?.retired?.(frame.service)
        throw new Error('Local MCP client generation or definition is unavailable')
      }
    }
    assertClient()
    try {
      if (scope === undefined) return await pool.call(frame.service, frame.name, frame.args, signal, frame.id, assertClient)
      return await scope.routes.run(scope.owner, frame, signal, (id, assertOwner) =>
        pool.call(frame.service, frame.name, frame.args, signal, id, () => { assertClient(); assertOwner() }))
    }
    finally {
      if (scope === undefined && !pool.available) socket.terminate()
      else if (scope !== undefined && !pool.hasIncarnation(frame.service, incarnation)) scope.retired?.(frame.service)
    }
  } })
}
