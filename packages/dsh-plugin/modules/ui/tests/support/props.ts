/** React bindings and dictionary lookup for component tests with plain injected props. */
import { useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

export function bindSnapshotSelector<T>(source: ObservableSnapshot<T>) {
  return function useSelector<R>(select: (state: T) => R): R {
    return select(useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot()))
  }
}

export function makeTranslate(...dictionaries: readonly Record<string, string>[]) {
  return (key: string, values?: Record<string, unknown>): string => {
    const text = dictionaries.map(dictionary => dictionary[key]).find(value => value !== undefined) ?? key
    return text.replace(/\{(\w+)\}/g, (match, name: string) => values && name in values ? String(values[name]) : match)
  }
}
