/** Execute installed DSH client factories against their real shared module namespaces. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import * as Jsx from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as Store from '@deepseek-ai/dsh-client-store'
import * as Slots from '@deepseek-ai/dsh-client-ui-slots'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'

const shared: Record<string, unknown> = { react: React, 'react/jsx-runtime': Jsx, 'react-dom': ReactDom,
  'react-dom/client': ReactDomClient, '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-store': Store,
  '@deepseek-ai/dsh-client-ui-slots': Slots, '@deepseek-ai/dsh-client-ui-primitives': Primitives }

/** @param name - Public DSH client entry. @returns Its actual exported namespace. */
export function publishedClient<T>(name: string): T {
  let registration: { id: string; factory(require: (name: string) => unknown): unknown } | undefined
  const loader = { load(row: NonNullable<typeof registration>) { registration = row } }
  const window = new Proxy({}, { get(_target, key) {
    if (key === '__ModuleLoader__') return loader
    const current = globalThis.window
    return current === undefined ? undefined : Reflect.get(current, key, current)
  } })
  const source = readFileSync(fileURLToPath(import.meta.resolve(name)), 'utf8')
  new Function('window', source)(window)
  if (registration === undefined || registration.id !== name.replace(/\/client$/, '')) throw new Error('Unexpected published client registration')
  return registration.factory((specifier) => {
    if (!(specifier in shared)) throw new Error(`Unknown shared browser module: ${specifier}`)
    return shared[specifier]
  }) as T
}
