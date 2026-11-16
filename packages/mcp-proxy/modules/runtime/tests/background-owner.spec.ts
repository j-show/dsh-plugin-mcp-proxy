import { expect, it } from 'vitest'
import { settleBackgroundOwner } from '../src/background-owner.ts'

it('terminates a remaining process group even after the direct child has exited', async () => {
  let alive = true
  const signals: NodeJS.Signals[] = []
  await settleBackgroundOwner({ rootExited: () => true, alive: () => alive, root: Promise.resolve(),
    signal: (signal) => { signals.push(signal); alive = false },
  }, { graceMs: 1000, reapMs: 1000, pollMs: 1 })
  expect(signals).toEqual(['SIGKILL'])
  expect(alive).toBe(false)
})

it('does not signal an already quiescent process owner', async () => {
  const signals: NodeJS.Signals[] = []
  await settleBackgroundOwner({ rootExited: () => true, alive: () => false, root: Promise.resolve(),
    signal: (signal) => { signals.push(signal) },
  }, { graceMs: 1000, reapMs: 1000, pollMs: 1 })
  expect(signals).toEqual([])
})

it('force-stops a live root and scope after graceful shutdown expires', async () => {
  let exited = false
  const root = Promise.withResolvers<undefined>()
  const signals: NodeJS.Signals[] = []
  await settleBackgroundOwner({ root: root.promise, rootExited: () => exited, alive: () => !exited,
    signal: (signal) => { signals.push(signal); exited = true; root.resolve(undefined) },
  }, { graceMs: 0, reapMs: 1000, pollMs: 1 })
  expect(signals).toEqual(['SIGKILL'])
})

it('rejects a scope that remains alive after its forced-reap deadline', async () => {
  const signals: NodeJS.Signals[] = []
  await expect(settleBackgroundOwner({ root: Promise.resolve(), rootExited: () => true, alive: () => true,
    signal: (signal) => { signals.push(signal) },
  }, { graceMs: 0, reapMs: 20, pollMs: 1 })).rejects.toThrow('Local MCP background cleanup failed')
  expect(signals).toEqual(['SIGKILL'])
})

it('waits for the direct-child exit observation even when its scope is already quiescent', async () => {
  let exited = false
  const root = Promise.withResolvers<undefined>()
  const signals: NodeJS.Signals[] = []
  const cleanup = settleBackgroundOwner({ root: root.promise, rootExited: () => exited, alive: () => false,
    signal: (signal) => { signals.push(signal) },
  }, { graceMs: 1000, reapMs: 1000, pollMs: 1 })
  queueMicrotask(() => { exited = true; root.resolve(undefined) })
  await cleanup
  expect(signals).toEqual([])
})

const denied=()=>Object.assign(new Error('Owned scope observation denied'),{code:'EPERM'})
it('reconciles a transient permission probe only after authoritative absence and root join',async()=>{
  let observations=0;const signals:NodeJS.Signals[]=[]
  await settleBackgroundOwner({root:Promise.resolve(),rootExited:()=>true,alive:()=>{if(++observations===1)throw denied();return false},signal:value=>{signals.push(value)}},
    {graceMs:0,reapMs:100,pollMs:1})
  expect(observations).toBeGreaterThan(1);expect(signals).toEqual([])
})
it('bounds persistent unknown presence without treating EPERM as absence or sending signals',async()=>{
  const signals:NodeJS.Signals[]=[]
  await expect(settleBackgroundOwner({root:Promise.resolve(),rootExited:()=>true,alive:()=>{throw denied()},signal:value=>{signals.push(value)}},
    {graceMs:0,reapMs:5,pollMs:1})).rejects.toMatchObject({message:'Local MCP background cleanup failed',cause:{code:'EPERM'}})
  expect(signals).toEqual([])
})
it('does not signal a newly visible group after uncertainty and loss of the direct-child anchor',async()=>{
  let observations=0;const signals:NodeJS.Signals[]=[]
  await expect(settleBackgroundOwner({root:Promise.resolve(),rootExited:()=>true,alive:()=>{if(++observations===1)throw denied();return true},signal:value=>{signals.push(value)}},
    {graceMs:0,reapMs:5,pollMs:1})).rejects.toThrow('Local MCP background cleanup failed')
  expect(signals).toEqual([])
})
it('verifies disappearance after a force-signal permission race without retrying signals',async()=>{
  let present=true;const signals:NodeJS.Signals[]=[]
  await settleBackgroundOwner({root:Promise.resolve(),rootExited:()=>true,alive:()=>present,signal:value=>{signals.push(value);present=false;throw denied()}},
    {graceMs:0,reapMs:100,pollMs:1})
  expect(signals).toEqual(['SIGKILL'])
})
it('routes the initial TERM fallback through the same observed scope policy',async()=>{
  let present=true;const signals:NodeJS.Signals[]=[]
  await settleBackgroundOwner({root:Promise.resolve(),rootExited:()=>!present,alive:()=>present,signal:value=>{signals.push(value);present=false;throw denied()}},
    {graceMs:5,reapMs:20,pollMs:1,fallbackSignal:'SIGTERM'})
  expect(signals).toEqual(['SIGTERM'])
})
it('does not send fallback TERM while presence is unknown',async()=>{
  let observations=0;const signals:NodeJS.Signals[]=[]
  await settleBackgroundOwner({root:Promise.resolve(),rootExited:()=>true,alive:()=>{if(++observations===1)throw denied();return false},signal:value=>{signals.push(value)}},
    {graceMs:0,reapMs:100,pollMs:1,fallbackSignal:'SIGTERM'})
  expect(signals).toEqual([])
})
it('preserves non-permission failures instead of reconciling them as process absence',async()=>{
  const error=Object.assign(new Error('scope inspection failed'),{code:'EIO'})
  await expect(settleBackgroundOwner({root:Promise.resolve(),rootExited:()=>true,alive:()=>{throw error},signal:()=>{}},
    {graceMs:0,reapMs:100,pollMs:1})).rejects.toBe(error)
})
