import { describe, expect, it } from 'vitest'
import { InvocationLedger, type InvocationId, type InvocationOutcome } from '../src/invocations.ts'

describe('connectivity invocation settlement', () => {
  it('admits an operation once and rejects duplicate execution', () => {
    const ledger = new InvocationLedger(4)
    expect(ledger.begin(('call-1' as InvocationId))).toEqual({ execute: true, state: 'pending' })
    expect(ledger.begin(('call-1' as InvocationId))).toEqual({ execute: false, state: 'pending' })
  })

  it('keeps a settled result when duplicate or late replies arrive', () => {
    const ledger = new InvocationLedger(4)
    ledger.begin(('call-1' as InvocationId))
    expect(ledger.settle(('call-1' as InvocationId), 'succeeded')).toBe(true)
    expect(ledger.settle(('call-1' as InvocationId), 'failed')).toBe(false)
    expect(ledger.begin(('call-1' as InvocationId))).toEqual({ execute: false, state: 'succeeded' })
  })

  it('marks every in-flight operation unknown on disconnect without reopening it', () => {
    const ledger = new InvocationLedger(4)
    ledger.begin(('call-1' as InvocationId))
    ledger.begin(('call-2' as InvocationId))
    ledger.settle(('call-2' as InvocationId), 'succeeded')
    ledger.disconnect()
    expect(ledger.begin(('call-1' as InvocationId))).toEqual({ execute: false, state: 'unknown' })
    expect(ledger.begin(('call-2' as InvocationId))).toEqual({ execute: false, state: 'succeeded' })
    expect(ledger.settle(('call-1' as InvocationId), 'succeeded')).toBe(false)
    expect(() => ledger.begin(('call-3' as InvocationId))).toThrow('closed')
  })

  it('refuses capacity exhaustion instead of forgetting an executed operation', () => {
    const ledger = new InvocationLedger(1)
    ledger.begin(('call-1' as InvocationId))
    ledger.settle(('call-1' as InvocationId), 'succeeded')
    expect(() => ledger.begin(('call-2' as InvocationId))).toThrow('capacity')
    expect(ledger.begin(('call-1' as InvocationId))).toEqual({ execute: false, state: 'succeeded' })
  })

  it('rejects a terminal reply for an operation that was never admitted', () => {
    expect(() => new InvocationLedger(4).settle(('missing' as InvocationId), 'succeeded')).toThrow('not admitted')
  })

  it.each<InvocationOutcome>(['failed', 'unknown'])('retains an initial %s outcome through disconnect and late success', (outcome) => {
    const ledger = new InvocationLedger(2)
    const id = 'call-1' as InvocationId
    ledger.begin(id)
    expect(ledger.settle(id, outcome)).toBe(true)
    ledger.disconnect()
    expect(ledger.settle(id, 'succeeded')).toBe(false)
    expect(ledger.begin(id)).toEqual({ execute: false, state: outcome })
  })

  it('closes all pending operations and tolerates repeated disconnect', () => {
    const ledger = new InvocationLedger(3)
    const first = 'first' as InvocationId
    const second = 'second' as InvocationId
    ledger.begin(first)
    ledger.begin(second)
    ledger.disconnect()
    ledger.disconnect()
    expect(ledger.begin(first)).toEqual({ execute: false, state: 'unknown' })
    expect(ledger.begin(second)).toEqual({ execute: false, state: 'unknown' })
    expect(() => ledger.begin('new' as InvocationId)).toThrow('closed')
  })

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid capacity %s', (capacity) => {
    expect(() => new InvocationLedger(capacity)).toThrow('positive safe integer')
  })
})
