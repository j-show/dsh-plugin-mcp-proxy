import { expect, it } from 'vitest'
import type { EndpointId } from '@jshow/app-mcp-proxy/protocol'
import { promptAdmissionId, ProxyAdmissions } from '../../src/host/admissions.ts'

const endpoint = 'endpoint' as EndpointId

it('consumes only the exact accepted input and only once', async () => {
  const admissions = new ProxyAdmissions()
  const identity = promptAdmissionId('session', 'request')
  await admissions.run(endpoint, () => identity, async () => {
    expect(admissions.claim(promptAdmissionId('another-session', 'request'))).toBeUndefined()
    expect(admissions.claim(identity)).toBe(endpoint)
    expect(admissions.claim(identity)).toBeUndefined()
  })
  expect(admissions.claim(identity)).toBeUndefined()
})

it('keeps concurrent requests separate and rejects asynchronous work inherited after delegation ends', async () => {
  const admissions = new ProxyAdmissions()
  const first = promptAdmissionId('session', 'first')
  const second = promptAdmissionId('session', 'second')
  const release = Promise.withResolvers<undefined>()
  let delayed: Promise<EndpointId | undefined> | undefined
  const firstOperation = admissions.run(endpoint, () => first, async () => {
    delayed = release.promise.then(() => admissions.claim(first))
  })
  await admissions.run('second' as EndpointId, () => second, async () => {
    expect(admissions.claim(first)).toBeUndefined()
    expect(admissions.claim(second)).toBe('second')
  })
  await firstOperation
  release.resolve(undefined)
  expect(await delayed).toBeUndefined()
})

it('waits for envelope identification and preserves delegated failures', async () => {
  const admissions = new ProxyAdmissions()
  const identity = promptAdmissionId('session', 'request')
  let parsed: typeof identity | undefined
  await expect(admissions.run(endpoint, () => parsed, async () => {
    expect(admissions.claim(identity)).toBeUndefined()
    parsed = identity
    expect(admissions.claim(identity)).toBe(endpoint)
    throw new Error('original failure')
  })).rejects.toThrow('original failure')
  expect(admissions.claim(identity)).toBeUndefined()
})
