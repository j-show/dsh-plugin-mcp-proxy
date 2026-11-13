/** Browser-ticket redemption grants device admission without granting a browser association. */
import type { AssociationRequest, AssociationRequestId, EndpointId } from '@j-show/mcp-proxy-protocol'
import type { DeviceRegistry } from './devices.ts'
import { decodeFrame, pairingChallenge, verifyRegistration } from '@j-show/mcp-proxy-protocol'

/** Explicit ticket and wire admission budgets. */
export interface DevicePairingOptions { readonly origin: string; readonly capacity: number; readonly maxFrameBytes: number }
interface Ticket { readonly expiresAt: number; state: 'pending' | 'consuming' | 'redeemed' | 'failed'; endpoint?: EndpointId }
/** Bounded one-use pairing owner; browser grants still require an admitted channel and finish route. */
export class DevicePairing {
  private readonly tickets = new Map<AssociationRequestId, Ticket>()
  /**
   * @param options - deployment budgets.
   * @param registry - durable device authority.
   * @param now - wall clock.
   * @param assertPending - live browser transaction check.
   */
  constructor(private readonly options: DevicePairingOptions, private readonly registry: DeviceRegistry,
    private readonly now: () => number, private readonly assertPending: (id: AssociationRequestId) => void) {
    const origin = new URL(options.origin)
    if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new Error('Invalid pairing origin')
    if (![options.capacity, options.maxFrameBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('Invalid pairing limits')
    }
  }
  /**
   * Issue one bounded ticket for the browser association.
   * @param request - transaction created by an authenticated browser.
   */
  issue(request: AssociationRequest): void {
    this.prune()
    this.assertPending(request.requestId)
    if (this.tickets.size >= this.options.capacity || this.tickets.has(request.requestId)) throw new Error('Pairing capacity exhausted')
    this.tickets.set(request.requestId, { expiresAt: request.expiresAt, state: 'pending' })
  }
  /**
   * Verify a ticket and device proof before committing registration.
   * @param id - URI ticket.
   * @param registration - origin/ticket-bound public proof.
   * @returns durable verified device identity.
   */
  async redeem(id: AssociationRequestId, registration: unknown): Promise<EndpointId> {
    this.prune()
    const ticket = this.tickets.get(id)
    if (ticket?.state !== 'pending') throw new Error('MCP device pairing unavailable')
    this.assertPending(id)
    let endpointId: EndpointId
    let publicKey: string
    try {
      const frame = decodeFrame(JSON.stringify(registration), this.options.maxFrameBytes)
      if (frame.kind !== 'register') throw new Error('Expected public identity proof')
      endpointId = verifyRegistration(frame, pairingChallenge(this.options.origin, id))
      publicKey = frame.publicKey
    } catch (_error) { throw new Error('MCP device pairing unavailable') }
    ticket.state = 'consuming'
    try {
      await this.registry.register({ endpointId, publicKey }, () => {
        this.assertPending(id)
        if (this.now() >= ticket.expiresAt || this.tickets.get(id) !== ticket) throw new Error('Pairing expired')
      })
      ticket.endpoint = endpointId
      ticket.state = 'redeemed'
      return endpointId
    } catch (_error) {
      ticket.state = 'failed'
      throw new Error('MCP device pairing unavailable')
    }
  }
  /**
   * Check whether the transaction was redeemed by this endpoint.
   * @param id - browser transaction.
   * @param endpoint - authenticated channel.
   * @returns whether that channel redeemed this ticket.
   */
  owns(id: AssociationRequestId, endpoint: EndpointId): boolean {
    this.prune()
    const ticket = this.tickets.get(id)
    return ticket?.state === 'redeemed' && ticket.endpoint === endpoint
  }

  private prune(): void {
    for (const [id, ticket] of this.tickets) {
      if (ticket.state !== 'consuming' && this.now() >= ticket.expiresAt) this.tickets.delete(id)
    }
  }
}
