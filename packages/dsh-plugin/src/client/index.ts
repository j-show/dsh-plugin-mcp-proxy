/** Browser-side local-computer connection settings plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ProxyUiConfig } from '../ui/types.ts'
import { ProxyConnectionController } from './controller.ts'
import { ConnectionSection, type ConnectionInjected } from './ConnectionSection.tsx'
import { en, zh, NS, type ProxyLocaleKey } from './locales.ts'
import { readUiConfig } from './config.ts'
import { ElicitationController } from './elicitation-controller.ts'
import { ElicitationDock, type ElicitationInjected } from './ElicitationDock.tsx'

export { Config } from '../ui/config.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'mcp-proxy': ProxyLocaleKey }
}
/** Settings slot ownership and typed feature dictionaries. */
export const inject = ['slots', 'locale']
/** @param ctx - Client plugin owner. @param bootstrap - Client Loader defaults for the initial deployment-configuration request. */
export async function apply(ctx: Context, bootstrap: ProxyUiConfig): Promise<void> {
  const stop = new AbortController()
  ctx.on('internal/plugin', (fiber) => {
    // Notifications for this fiber denote disposal after registration.
    if (fiber === ctx.fiber) stop.abort()
  })
  const tasks = new Set<Promise<void>>()
  const retainWork = (task: Promise<void>): void => {
    tasks.add(task)
    const finish = (): void => { tasks.delete(task) }
    void task.then(finish, finish)
  }
  ctx.effect(() => async () => { stop.abort(); while (tasks.size > 0) await Promise.allSettled(tasks) })
  let config: ProxyUiConfig
  try { config = await readUiConfig(bootstrap, (url, init) => fetch(url, init), stop.signal) } catch (error) {
    if (stop.signal.aborted) return
    throw error
  }
  if (stop.signal.aborted) return
  const controller = new ProxyConnectionController(config, (url, init) => fetch(url, init), (uri) => {
    if (typeof window === 'undefined') throw new Error('Browser activation unavailable')
    window.location.assign(uri)
  })
  ctx.effect(() => { controller.start(); return () => controller.close() })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'mcp-proxy', order: 19, label: () => t('nav'), locale: NS,
    inject: (): ConnectionInjected => ({ hooks: { mcpProxyConnection: controller.state },
      connect: () => controller.connect(), refresh: () => controller.refresh(), disconnect: () => controller.disconnect(),
    }),
  }, ConnectionSection))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'mcp-proxy-elicitation', order: 30, locale: NS,
    inject: (sessionId): ElicitationInjected => {
      const requests = new ElicitationController(config, sessionId, (url, init) => fetch(url, init), stop.signal, retainWork)
      return { hooks: { mcpProxyElicitation: requests.state },
        answer: (id, action, content) => requests.respond(id, action, content), refreshElicitation: () => requests.refresh(),
      }
    },
  }, ElicitationDock))
}
