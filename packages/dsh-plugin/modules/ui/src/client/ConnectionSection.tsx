/** Settings surface for this browser's local-computer association. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionState } from './controller.ts'
import { NS } from './locales.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ConnectionSection.module.css'

/** Controller-owned facts and gesture callbacks exposed through the renderer. */
export interface ConnectionInjected {
  hooks: { mcpProxyConnection: ObservableSnapshot<ConnectionState> }
  connect(): Promise<void>
  refresh(): Promise<void>
  disconnect(): Promise<void>
}
/** Full Settings-section props assembled by the slot framework. */
export type ConnectionSectionProps = PropsRuntime<'settings.section'> & InjectFace<ConnectionInjected> & PropsLocale<typeof NS>
/** @param props - framework-derived state, locale and gesture callbacks. @returns local connection controls. */
export function ConnectionSection({ useMcpProxyConnection, connect, refresh, disconnect, t }: ConnectionSectionProps) {
  const state = useMcpProxyConnection(value => value)
  const busy = state.phase === 'loading' || state.phase === 'opening' || state.phase === 'waiting' || state.phase === 'disconnecting'
  return (
    <section className={css.section}>
      <h3 className={css.title}>{t('title')}</h3>
      <p className={css.hint}>{t('hint')}</p>
      <p className={css.status} role="status" aria-live="polite">{t(state.phase)}</p>
      <div className={css.actions}>
        <Button variant="primary" className={css.control} disabled={busy} onClick={() => { void connect() }}>
          {t(state.phase === 'connected' ? 'reconnect' : 'connect')}
        </Button>
        <Button variant="outline" className={css.control} disabled={busy} onClick={() => { void refresh() }}>{t('refresh')}</Button>
        {state.phase === 'connected' && (
          <Button className={css.control} onClick={() => { void disconnect() }}>{t('disconnect')}</Button>
        )}
      </div>
      {state.phase === 'waiting' && state.uri !== null && <a className={css.link} href={state.uri} rel="noreferrer">{t('open')}</a>}
      {state.phase === 'connected' && (
        state.services.length === 0 ? <p className={css.hint}>{t('noServices')}</p>
          : <ul className={css.services} aria-label={t('services')}>{state.services.map(service => <li key={service}>{service}</li>)}</ul>
      )}
      <p className={css.hint}>{t('turnHint')}</p>
    </section>
  )
}
