/** Local management presentation; all executable operations cross the narrow preload bridge. */
import type { LocalDesktopSnapshot, LocalManagementReply } from '@jshow/app-mcp-proxy/local/management'
import type { GuiCommand, BootstrapState } from './api.ts'
import { desktopMessages, type DesktopMessageKey } from './messages.ts'

const t = desktopMessages(navigator.language)
document.documentElement.lang = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  element.textContent = t(element.dataset['i18n'] as DesktopMessageKey)
}
function element(id: string): HTMLElement {
  const result = document.getElementById(id)
  if (result === null) throw new Error('Missing local interface element')
  return result
}
const form = element('mcp-form') as HTMLFormElement
const modal = element('mcp-dialog') as HTMLDialogElement
const busy = new Set<string>()
let snapshot: LocalDesktopSnapshot | undefined
let bootstrapState: BootstrapState = 'starting'
let toastTimer: ReturnType<typeof setTimeout> | undefined
const stateKeys: Record<LocalDesktopSnapshot['servers'][number]['state'], DesktopMessageKey> = {
  connected: 'connected', connecting: 'connecting', reconnecting: 'reconnecting', disconnected: 'disconnected', error: 'error',
}
const errorKeys: Record<Extract<LocalManagementReply, { ok:false }>['code'], DesktopMessageKey> = {
  'invalid-request': 'invalidRequest', 'operation-failed': 'operationFailed', 'restart-required': 'restartRequired', 'pairing-failed': 'pairingFailed',
}
function toast(key: DesktopMessageKey): void {
  clearTimeout(toastTimer)
  const target = element('toast'); target.textContent = t(key); target.hidden = false
  toastTimer = setTimeout(() => { target.hidden = true }, 6000)
}
function button(key: DesktopMessageKey, action: () => void, className = 'quiet'): HTMLButtonElement {
  const result = document.createElement('button')
  result.type = 'button'; result.textContent = t(key); result.className = className
  result.addEventListener('click', action)
  return result
}
function row(title: string, subtitle?: string): { row: HTMLElement; body: HTMLElement } {
  const result = document.createElement('div'); result.className = 'row'
  const body = document.createElement('div'); body.className = 'row-main'
  const heading = document.createElement('div'); heading.className = 'row-title'; heading.textContent = title
  body.append(heading)
  if (subtitle !== undefined) {
    const detail = document.createElement('div'); detail.className = 'row-subtitle'; detail.textContent = subtitle; body.append(detail)
  }
  result.append(body)
  return { row: result, body }
}
function badge(label: string, state: string): HTMLElement {
  const target = document.createElement('span'); target.className = `badge ${state}`; target.textContent = label
  return target
}
async function run(key: string, command: GuiCommand, success?: () => void): Promise<void> {
  if (busy.has(key)) return
  busy.add(key); render()
  try {
    const result = await window.mcpProxy.request(command)
    if (result.ok) { snapshot = result.snapshot; success?.() }
    else toast(errorKeys[result.code])
  } catch (_error) { toast('operationFailed') }
  finally { busy.delete(key); render() }
}
function empty(target: HTMLElement, key: DesktopMessageKey): void {
  const node = document.createElement('div'); node.className = 'empty'; node.textContent = t(key); target.append(node)
}
function render(): void {
  const available = bootstrapState === 'ready' || bootstrapState === 'protocolFailed'
  const connections = element('connections'); connections.replaceChildren()
  if (!snapshot?.servers.length) empty(connections, 'emptyConnections')
  for (const server of snapshot?.servers ?? []) {
    const target = row(server.origin)
    target.row.append(badge(t(available ? stateKeys[server.state] : 'unavailable'), available ? server.state : 'error'))
    const key = `disconnect:${server.id}`
    const action = button('disconnect', () => {
      void window.mcpProxy.confirm(`${t('disconnectConfirm')}\n\n${server.origin}`)
        .then(confirmed => { if (confirmed) return run(key, { kind: 'disconnect', id: server.id }) }).catch(() => { toast('operationFailed') })
    })
    action.disabled = !available || busy.has(key) || server.state === 'disconnected'
    target.row.append(action); connections.append(target.row)
  }
  const mcps = element('mcps'); mcps.replaceChildren()
  if (!snapshot?.services.length) empty(mcps, 'emptyMcps')
  for (const service of snapshot?.services ?? []) {
    const transport = service.transport === 'stdio' ? 'stdio' : service.transport === 'sse' ? 'sse' : 'http'
    const target = row(service.service, t(transport))
    target.row.append(badge(t(service.ready ? 'ready' : 'unavailable'), service.ready ? 'ready' : 'error'))
    const key = `remove:${service.service}`
    const action = button('remove', () => {
      void window.mcpProxy.confirm(`${t('removeConfirm')}\n\n${service.service}`)
        .then(confirmed => { if (confirmed) return run(key, { kind: 'remove-mcp', service: service.service }) }).catch(() => { toast('operationFailed') })
    }, 'quiet danger')
    action.disabled = !available || busy.has(key); target.row.append(action); mcps.append(target.row)
  }
  element('workspace').textContent = snapshot?.directory ?? ''
  element('settings-file').textContent = snapshot?.settingsFile ?? ''
  ;(element('save-mcp') as HTMLButtonElement).disabled = !available || busy.has('add')
  ;(element('add-mcp') as HTMLButtonElement).disabled = !available
}
function choosePage(mcps: boolean): void {
  element('mcps-page').hidden = !mcps; element('connections-page').hidden = mcps
  element('nav-mcps').classList.toggle('active', mcps); element('nav-connections').classList.toggle('active', !mcps)
}
function field(name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const control = form.elements.namedItem(name)
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement)) {
    throw new Error('Missing local configuration field')
  }
  return control
}
function transportFields(): void {
  const stdio = field('transport').value === 'stdio'
  element('stdio-fields').hidden = !stdio; element('http-fields').hidden = stdio
  field('command').disabled = !stdio; (field('command') as HTMLInputElement).required = stdio
  field('url').disabled = stdio; (field('url') as HTMLInputElement).required = !stdio
  const env = field('env').closest('label'); if (env !== null) env.hidden = !stdio
  const headers = field('headers').closest('label'); if (headers !== null) headers.hidden = stdio
}
function jsonField(name: string): unknown {
  const text = field(name).value.trim()
  return text ? JSON.parse(text) as unknown : {}
}
form.addEventListener('submit', (event) => {
  event.preventDefault()
  try {
    const transport = field('transport').value
    const cwd = field('cwd').value.trim()
    const roots = field('roots').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const service = { service: field('service').value.trim(), transport, ...(cwd ? { cwd } : {}), ...(roots.length ? { roots } : {}),
      ...(transport === 'stdio' ? { command: field('command').value.trim(), args: field('args').value.split(/\r?\n/).filter(Boolean), env: jsonField('env') }
        : { url: field('url').value.trim(), headers: jsonField('headers') }),
    }
    void run('add', { kind: 'add-mcp', service }, () => { form.reset(); transportFields(); modal.close() })
  } catch (_error) { toast('invalidRequest') }
})
element('nav-connections').addEventListener('click', () => { choosePage(false) })
element('nav-mcps').addEventListener('click', () => { choosePage(true) })
element('add-mcp').addEventListener('click', () => { transportFields(); modal.showModal() })
field('transport').addEventListener('change', transportFields)
for (const id of ['close-dialog', 'cancel-mcp']) element(id).addEventListener('click', () => { form.reset(); modal.close() })
element('exit').addEventListener('click', () => { void window.mcpProxy.exit().catch(() => { toast('stopFailed') }) })
element('register-uri').addEventListener('click', () => { void window.mcpProxy.registerUri().catch(() => { toast('protocolFailed') }) })
window.mcpProxy.subscribe((value) => { snapshot = value; render() })
window.mcpProxy.bootstrap((state: BootstrapState) => {
  bootstrapState = state
  element('bootstrap-banner').hidden = state === 'ready'
  element('bootstrap-message').textContent = t(state === 'ready' ? 'serviceReady' : state)
  element('service-state').textContent = t(state === 'ready' || state === 'protocolFailed' ? 'serviceReady' : state)
  element('register-uri').hidden = state !== 'protocolFailed'
  render()
})
transportFields(); render()
