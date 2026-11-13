import { describe, expect, it } from 'vitest'
import { AssociationStore, type BrowserBindingId, type EndpointId } from '../src/associations.ts'

const browser = 'browser-a' as BrowserBindingId
const otherBrowser = 'browser-b' as BrowserBindingId
const endpoint = 'machine-a' as EndpointId

function setup(capacity = 8) {
  let now = 100
  const store = new AssociationStore({ capacity, challengeLifetimeMs: 10, grantLifetimeMs: 50 }, () => now)
  return { store, advance: (value: number) => { now = value } }
}

describe('browser association', () => {
  it('does not grant a route before a local authenticated connection confirms the request', () => {
    const { store } = setup()
    const request = store.begin(browser)
    expect(() => store.finish(request.requestId, browser)).toThrow('not confirmed')
    store.confirm(request.requestId, endpoint)
    const grant = store.finish(request.requestId, browser)
    expect(store.resolve(grant.handle, browser)).toBe(endpoint)
  })

  it('does not let another browser consume a confirmed request or use its grant', () => {
    const { store } = setup()
    const request = store.begin(browser)
    store.confirm(request.requestId, endpoint)
    expect(() => store.finish(request.requestId, otherBrowser)).toThrow('browser')
    const grant = store.finish(request.requestId, browser)
    expect(() => store.resolve(grant.handle, otherBrowser)).toThrow('browser')
    expect(store.resolve(grant.handle, browser)).toBe(endpoint)
  })

  it('accepts one confirmation and one consumption only', () => {
    const { store } = setup()
    const request = store.begin(browser)
    store.confirm(request.requestId, endpoint)
    expect(() => store.confirm(request.requestId, 'machine-b' as EndpointId)).toThrow('already confirmed')
    store.finish(request.requestId, browser)
    expect(() => store.finish(request.requestId, browser)).toThrow('unavailable')
  })

  it('expires requests at their deadline even if confirmation has arrived', () => {
    const { store, advance } = setup()
    const request = store.begin(browser)
    store.confirm(request.requestId, endpoint)
    advance(110)
    expect(() => store.finish(request.requestId, browser)).toThrow('expired')
  })

  it('expires unconfirmed requests and refuses late connector confirmation', () => {
    const { store, advance } = setup()
    const request = store.begin(browser)
    advance(110)
    expect(() => store.confirm(request.requestId, endpoint)).toThrow('expired')
  })

  it('expires grants without substituting a different endpoint', () => {
    const { store, advance } = setup()
    const request = store.begin(browser)
    store.confirm(request.requestId, endpoint)
    const grant = store.finish(request.requestId, browser)
    advance(150)
    expect(() => store.resolve(grant.handle, browser)).toThrow('expired')
  })

  it('renews an active verified browser grant without changing its handle or endpoint', () => {
    const { store, advance } = setup(1)
    const request = store.begin(browser)
    store.confirm(request.requestId, endpoint)
    const grant = store.finish(request.requestId, browser)
    advance(140)
    const renewed = store.renew(grant.handle, browser)
    expect(renewed).toEqual({ handle: grant.handle, expiresAt: 190 })
    advance(160)
    expect(store.resolve(renewed.handle, browser)).toBe(endpoint)
    expect(() => store.begin(otherBrowser)).toThrow('capacity')
  })

  it('does not let a foreign browser renew authority or recover an expired grant', () => {
    const { store, advance } = setup()
    const request = store.begin(browser)
    store.confirm(request.requestId, endpoint)
    const grant = store.finish(request.requestId, browser)
    advance(140)
    expect(() => store.renew(grant.handle, otherBrowser)).toThrow('browser')
    advance(150)
    expect(() => store.renew(grant.handle, browser)).toThrow('expired')
  })

  it('uses opaque distinct request and grant identities', () => {
    const { store } = setup()
    const first = store.begin(browser)
    const second = store.begin(otherBrowser)
    expect(first.requestId).not.toBe(second.requestId)
    expect(first.requestId).not.toContain(browser)
    store.confirm(first.requestId, endpoint)
    const grant = store.finish(first.requestId, browser)
    expect(grant.handle).not.toBe(first.requestId)
    expect(grant.handle).not.toContain(endpoint)
  })

  it('bounds retained state and reclaims expired entries', () => {
    const { store, advance } = setup(1)
    store.begin(browser)
    expect(() => store.begin(otherBrowser)).toThrow('capacity')
    advance(110)
    expect(store.begin(otherBrowser).expiresAt).toBe(120)
  })

  it('invalidates prior browser authority when a replacement association begins and finishes', () => {
    const { store } = setup(1)
    const first = store.begin(browser)
    store.confirm(first.requestId, endpoint)
    const old = store.finish(first.requestId, browser)
    const replacement = store.begin(browser)
    expect(() => store.resolve(old.handle, browser)).toThrow('unavailable')
    const next = 'machine-b' as EndpointId
    store.confirm(replacement.requestId, next)
    const current = store.finish(replacement.requestId, browser)
    expect(() => store.renew(old.handle, browser)).toThrow('unavailable')
    expect(store.resolve(current.handle, browser)).toBe(next)
  })

  it('refuses confirmation of an older browser attempt without revoking another browser', () => {
    const { store } = setup()
    const foreign = store.begin(otherBrowser)
    store.confirm(foreign.requestId, endpoint)
    const foreignGrant = store.finish(foreign.requestId, otherBrowser)
    const old = store.begin(browser)
    const current = store.begin(browser)
    expect(() => store.confirm(old.requestId, endpoint)).toThrow('unavailable')
    store.confirm(current.requestId, endpoint)
    store.finish(current.requestId, browser)
    expect(store.resolve(foreignGrant.handle, otherBrowser)).toBe(endpoint)
  })

  it('revokes pending and granted associations for a browser', () => {
    const { store } = setup()
    const request = store.begin(browser)
    store.confirm(request.requestId, endpoint)
    const grant = store.finish(request.requestId, browser)
    const pending = store.begin(browser)
    store.confirm(pending.requestId, endpoint)
    store.revoke(browser)
    expect(() => store.resolve(grant.handle, browser)).toThrow('unavailable')
    expect(() => store.confirm(pending.requestId, endpoint)).toThrow('unavailable')
  })

  it('counts live grants against capacity and reclaims them after expiration', () => {
    const { store, advance } = setup(1)
    const request = store.begin(browser)
    store.confirm(request.requestId, endpoint)
    store.finish(request.requestId, browser)
    expect(() => store.begin(otherBrowser)).toThrow('capacity')
    advance(150)
    expect(store.begin(otherBrowser).expiresAt).toBe(160)
  })

  it('does not revoke another browser or its pending association', () => {
    const { store } = setup()
    const own = store.begin(browser)
    store.confirm(own.requestId, endpoint)
    store.finish(own.requestId, browser)
    const other = store.begin(otherBrowser)
    store.confirm(other.requestId, endpoint)
    const grant = store.finish(other.requestId, otherBrowser)
    const pendingBrowser = 'browser-c' as BrowserBindingId
    const pending = store.begin(pendingBrowser)
    store.revoke(browser)
    expect(store.resolve(grant.handle, otherBrowser)).toBe(endpoint)
    store.confirm(pending.requestId, endpoint)
    expect(store.finish(pending.requestId, pendingBrowser).handle).toBeTruthy()
  })

  it.each([0, -1, 0.5, NaN, Infinity])('rejects invalid capacity %s', (capacity) => {
    expect(() => setup(capacity)).toThrow('positive safe integer')
  })

  it.each(['challengeLifetimeMs', 'grantLifetimeMs'] as const)('rejects invalid %s', (field) => {
    expect(() => new AssociationStore({ capacity: 1, challengeLifetimeMs: 10, grantLifetimeMs: 20, [field]: 0 }, () => 0)).toThrow('positive safe integer')
  })
})
