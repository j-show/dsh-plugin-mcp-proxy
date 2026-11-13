/** Expiring, browser-bound local endpoint association; caller authenticates connector confirmations. */
import { randomBytes } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of an authenticated browser session, supplied by the HTTP owner. */
export type BrowserBindingId = Branded<'McpProxyBrowserBindingId'>
/** Stable identity of an authenticated local proxy installation. */
export type EndpointId = Branded<'McpProxyEndpointId'>
/** Single-use association transaction carried by a system URI. */
export type AssociationRequestId = Branded<'McpProxyAssociationRequestId'>
/** Secret browser-bound grant carried in an HttpOnly cookie. */
export type AssociationHandle = Branded<'McpProxyAssociationHandle'>

/** Deployment-resolved storage and lifetime limits. */
export interface AssociationOptions {
  readonly capacity: number
  readonly challengeLifetimeMs: number
  readonly grantLifetimeMs: number
}

/** Public association transaction; contains no endpoint authority before confirmation. */
export interface AssociationRequest {
  readonly requestId: AssociationRequestId
  readonly expiresAt: number
}

/** Completed association returned only to its initiating browser. */
export interface AssociationGrant {
  readonly handle: AssociationHandle
  readonly expiresAt: number
}

interface Expiring {
  readonly browser: BrowserBindingId
  readonly expiresAt: number
}

interface PendingAssociation extends Expiring {
  readonly endpoint?: EndpointId
}

interface BoundAssociation extends Expiring {
  readonly endpoint: EndpointId
}

/** One deployment's in-memory association transactions and browser grants. */
export class AssociationStore {
  private readonly requests = new Map<AssociationRequestId, PendingAssociation>()
  private readonly grants = new Map<AssociationHandle, BoundAssociation>()
  private readonly options: AssociationOptions

  /**
   * @param options - positive safe integer deployment limits; capacity includes requests and grants.
   * @param now - owner-supplied wall clock, in milliseconds.
   */
  constructor(options: AssociationOptions, private readonly now: () => number) {
    for (const [name, value] of Object.entries(options)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`)
    }
    this.options = { ...options }
  }

  /**
   * Start a bounded replacement transaction; prior authority for this browser is revoked first.
   * @param browser - verified initiating browser identity.
   * @returns opaque URI transaction and its deadline; throws when storage is full.
   */
  begin(browser: BrowserBindingId): AssociationRequest {
    const now = this.now()
    this.prune(this.requests, now)
    this.prune(this.grants, now)
    this.revoke(browser)
    if (this.requests.size + this.grants.size >= this.options.capacity) throw new Error('association capacity exhausted')
    const requestId = randomBytes(32).toString('base64url') as AssociationRequestId
    const expiresAt = now + this.options.challengeLifetimeMs
    this.requests.set(requestId, { browser, expiresAt })
    return { requestId, expiresAt }
  }

  /**
   * Confirm a transaction through an already authenticated connector channel.
   * @param requestId - unexpired URI transaction.
   * @param endpoint - identity verified by the connection owner, never a bare browser claim.
   */
  confirm(requestId: AssociationRequestId, endpoint: EndpointId): void {
    const request = this.lookup(this.requests, requestId)
    if (request.endpoint !== undefined) throw new Error('association already confirmed')
    this.requests.set(requestId, { ...request, endpoint })
  }

  /**
   * Reject a transaction that is missing, expired or already consumed.
   * @param requestId - unconsumed browser transaction.
   * @throws when expired, revoked or already confirmed.
   */
  assertPending(requestId: AssociationRequestId): void {
    if (this.lookup(this.requests, requestId).endpoint !== undefined) throw new Error('Association is already confirmed')
  }

  /**
   * Exchange a confirmed transaction once; wrong-browser attempts do not consume it.
   * @param requestId - confirmed transaction identity.
   * @param browser - authenticated caller of the completion route.
   * @returns secret association cookie value and expiry.
   */
  finish(requestId: AssociationRequestId, browser: BrowserBindingId): AssociationGrant {
    const request = this.lookup(this.requests, requestId)
    if (request.browser !== browser) throw new Error('association browser mismatch')
    if (request.endpoint === undefined) throw new Error('association not confirmed')
    this.revoke(browser)
    const handle = randomBytes(32).toString('base64url') as AssociationHandle
    const expiresAt = this.now() + this.options.grantLifetimeMs
    this.grants.set(handle, { browser, expiresAt, endpoint: request.endpoint })
    return { handle, expiresAt }
  }

  /**
   * Resolve one unexpired browser grant; the connection registry still checks endpoint liveness.
   * @param handle - cookie value admitted by the route parser.
   * @param browser - current authenticated browser identity.
   * @returns associated endpoint identity; throws for unavailable, expired or foreign grants.
   */
  resolve(handle: AssociationHandle, browser: BrowserBindingId): EndpointId {
    const grant = this.lookup(this.grants, handle)
    if (grant.browser !== browser) throw new Error('association browser mismatch')
    return grant.endpoint
  }

  /**
   * Renew the live association grant for its existing browser.
   * @param handle - unexpired grant supplied by the authenticated HTTP owner.
   * @param browser - the same verified browser binding.
   * @returns the existing handle with an extended deadline; endpoint authority does not change.
   */
  renew(handle: AssociationHandle, browser: BrowserBindingId): AssociationGrant {
    const grant = this.lookup(this.grants, handle)
    if (grant.browser !== browser) throw new Error('association browser mismatch')
    const expiresAt = Math.max(grant.expiresAt, this.now() + this.options.grantLifetimeMs)
    this.grants.set(handle, { ...grant, expiresAt })
    return { handle, expiresAt }
  }

  /**
   * Revoke this browser's pending transactions and completed grants.
   * @param browser - browser whose authority ended.
   */
  revoke(browser: BrowserBindingId): void {
    for (const [id, entry] of this.requests) if (entry.browser === browser) this.requests.delete(id)
    for (const [id, entry] of this.grants) if (entry.browser === browser) this.grants.delete(id)
  }

  private lookup<Id extends string, Value extends Expiring>(entries: Map<Id, Value>, id: Id): Value {
    const entry = entries.get(id)
    if (entry === undefined) throw new Error('association unavailable')
    if (entry.expiresAt <= this.now()) {
      entries.delete(id)
      throw new Error('association expired')
    }
    return entry
  }

  private prune<Id extends string, Value extends Expiring>(entries: Map<Id, Value>, now: number): void {
    for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id)
  }
}
