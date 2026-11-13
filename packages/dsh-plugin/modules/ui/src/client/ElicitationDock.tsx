/** Session-local human input surface; data subscriptions and requests belong to the injected controller. */
import { useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ElicitationController, ElicitationState, UiElicitation } from './elicitation-controller.ts'
import { NS } from './locales.ts'
import css from './ElicitationDock.module.css'

/** Plain action callbacks and the registrant-private observable hook source. */
export interface ElicitationInjected {
  hooks: { mcpProxyElicitation: ObservableSnapshot<ElicitationState> }
  answer: ElicitationController['respond']
  refreshElicitation(): Promise<void>
}
/** Session dock shares owned by the slot framework. */
export type ElicitationDockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<ElicitationInjected> & PropsLocale<typeof NS>
interface FormProps {
  readonly pending: UiElicitation
  readonly busy: boolean
  readonly answer: ElicitationInjected['answer']
  readonly t: ElicitationDockProps['t']
}
function ElicitationForm({ pending, busy, answer, t }: FormProps) {
  const fields = pending.params.mode === 'form' ? pending.params.fields : []
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map(field => [field.name, field.initial])))
  const change = (name: string, value: unknown): void => { setValues(previous => ({ ...previous, [name]: value })) }
  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      const content = pending.params.mode === 'form' ? Object.fromEntries(fields
        .filter(field => values[field.name] !== undefined)
        .map(field => [field.name, values[field.name]])) : undefined
      void answer(pending.id, 'accept', content)
    }}>
      <p className={css.message}>{pending.params.message}</p>
      {pending.params.mode === 'url' && <a className={css.link} href={pending.params.url} target="_blank" rel="noopener noreferrer">
        {t('elicitationOpen')}
      </a>}
      {fields.map((field, index) => {
        const id = `${pending.id}-${index}`
        return <div className={css.field} key={field.name}>
          <label htmlFor={id}>{field.label}{field.required ? ' *' : ''}</label>
          {field.description !== undefined && <p className={css.description}>{field.description}</p>}
          {field.kind === 'boolean'
            ? <input id={id} type="checkbox" checked={values[field.name] === true} disabled={busy}
              onChange={event => change(field.name, event.target.checked)} />
            : field.kind === 'select' || field.kind === 'multi'
              ? <select id={id} multiple={field.kind === 'multi'} disabled={busy}
                required={field.kind === 'select' && field.required}
                value={field.kind === 'multi'
                  ? field.choices.flatMap((choice, option) => Array.isArray(values[field.name])
                        && (values[field.name] as unknown[]).includes(choice.value) ? [String(option)] : [])
                  : String(field.choices.findIndex(choice => choice.value === values[field.name]))}
                onChange={event => change(field.name, field.kind === 'multi'
                  ? [...event.target.selectedOptions].map(option => field.choices[Number(option.value)]?.value)
                  : field.choices[Number(event.target.value)]?.value)}>
                {field.kind === 'select' && <option value="-1">{t('elicitationChoose')}</option>}
                {field.choices.map((choice, option) => <option key={choice.value} value={option}>{choice.label}</option>)}
              </select>
              : <input id={id} type={field.kind === 'number' ? 'number' : 'text'} disabled={busy}
                required={field.kind === 'number' && field.required} step={field.integer ? 1 : 'any'}
                value={typeof values[field.name] === 'string' || typeof values[field.name] === 'number'
                  ? values[field.name] as string | number : ''}
                onChange={event => change(field.name, field.kind === 'number'
                  ? Number.isNaN(event.target.valueAsNumber) ? undefined : event.target.valueAsNumber : event.target.value)} />}
        </div>
      })}
      <div className={css.actions}>
        <Button type="submit" variant="primary" disabled={busy}>{t(pending.params.mode === 'url' ? 'elicitationContinue' : 'elicitationSubmit')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => { void answer(pending.id, 'decline') }}>{t('elicitationDecline')}</Button>
        <Button type="button" disabled={busy} onClick={() => { void answer(pending.id, 'cancel') }}>{t('elicitationCancel')}</Button>
      </div>
      <p className={css.description}>{t('elicitationRetained')}</p>
    </form>
  )
}
/** @param props - Session-scoped facts, actions and locale. @returns the current human request, or nothing. */
export function ElicitationDock({ useMcpProxyElicitation, answer, refreshElicitation, t }: ElicitationDockProps) {
  const state = useMcpProxyElicitation(value => value)
  if (state.pending === null && !state.error) return null
  return <section className={css.panel} aria-label={t('elicitationTitle')}>
    <h3 className={css.title}>{t('elicitationTitle')}</h3>
    {state.error && <p role="alert">{t('elicitationError')} <Button onClick={() => { void refreshElicitation() }}>{t('refresh')}</Button></p>}
    {state.pending !== null && <ElicitationForm key={state.pending.id} pending={state.pending} busy={state.busy} answer={answer} t={t} />}
  </section>
}
