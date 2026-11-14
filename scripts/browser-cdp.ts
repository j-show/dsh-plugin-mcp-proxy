/** Minimal CDP transport for real headed browser tests; no TLS or protocol prompt suppression. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Keep useful client activation errors while excluding authentication and profile data. */
export function safeBrowserDiagnostic(raw: string): string {
  if (/authorization|set-cookie|\bcookie\b|password|credential|api[_ -]?key|\bsecret\b|\bbearer\b|private[_ -]?key|BEGIN[\s\S]{0,80}PRIVATE KEY/i.test(raw)) return '[sensitive diagnostic omitted]'
  return raw.replace(/mcp-proxy:\/\/associate\/[^\s"'<>]+/gi, '[activation omitted]')
    .replace(/https?:\/\/[^\s"'<>)]*/gi, value => { try { const url = new URL(value); return url.origin + url.pathname } catch { return '[url omitted]' } })
    .replace(/\btoken=[^\s"'&,;]*/gi, 'token=[redacted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .replace(/[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email omitted]')
    .slice(0, 2048)
}

export async function eventually<T>(read: () => Promise<T | undefined | false>, label: string, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined && result !== false) return result
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Deadline: ${label}`)
}
/** Each navigation is a separate required observation, never a retry of a failed boot. */
export async function verifyPageBoots(count: number, boot: (index: number) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid startup observation count')
  for (let index = 0; index < count; index++) await boot(index)
}
export class BrowserCdp {
  private id = 0
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly errors: Array<{ kind: string; message: string }> = []
  private readonly scripts = new Map<string, string>()
  private constructor(private readonly socket: WebSocket, private readonly diagnosticOrigin?: string) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown; method?: string;
        params?: { type?: string; url?: string; hash?: string; args?: Array<{ value?: unknown; description?: string }>;
          exceptionDetails?: { text?: string; exception?: { description?: string } }; entry?: { level?: string; text?: string } } }
      const record = (kind: string, value: string) => { this.errors.push({ kind, message: safeBrowserDiagnostic(value) }); if (this.errors.length > 64) this.errors.shift() }
      if (message.method === 'Runtime.exceptionThrown') record('exception', message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? 'Client exception')
      if (message.method === 'Runtime.consoleAPICalled') {
        const value = (message.params?.args ?? []).slice(0, 10).map(arg => typeof arg.value === 'string' ? arg.value : arg.description ?? '').join(' ')
        if (['error', 'warning'].includes(message.params?.type ?? '') || /\berror\b|\bfailed\b|mcp-proxy|ui-config|locale|slots/i.test(value)) record('console', value)
      }
      if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params?.entry?.level ?? '')) record('log', message.params?.entry?.text ?? 'Client log error')
      if (message.method === 'Debugger.scriptParsed' && this.diagnosticOrigin && /^[A-Za-z0-9_-]{16,128}$/.test(message.params?.hash ?? '')) {
        try {
          const url = new URL(message.params?.url ?? '')
          if (url.origin === this.diagnosticOrigin && /[.]m?js$/.test(url.pathname) && this.scripts.size < 128) this.scripts.set(url.pathname, message.params!.hash!)
        } catch { /* Ignore blank/evaluated scripts and unrelated browser code. */ }
      }
      if (!message.id) return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id); clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error('CDP command failed')); else entry.resolve(message.result)
    })
    socket.addEventListener('close', () => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP closed')) }; this.pending.clear() })
  }
  static async page(profile: string, diagnosticOrigin?: string, checkProcess: () => void = () => {}): Promise<BrowserCdp> {
    const port = await eventually(async () => {
      checkProcess()
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || undefined } catch { return undefined }
    }, 'owned browser debugging endpoint')
    const target = await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
      const rows = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>
      return rows.find(row => row.type === 'page')
    }, 'browser page')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Cannot open browser CDP')), { once: true }) })
    const client = new BrowserCdp(socket, diagnosticOrigin)
    await Promise.all([client.send('Runtime.enable'), client.send('Log.enable'), ...(diagnosticOrigin ? [client.send('Debugger.enable')] : [])])
    return client
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as { result?: { value?: T }; exceptionDetails?: unknown }
    if (response.exceptionDetails) throw new Error('Browser evaluation failed')
    return response.result?.value as T
  }
  async clickText(pattern: string): Promise<void> {
    const point = await eventually(() => this.evaluate<{ x: number; y: number } | false>(`(() => {const r=new RegExp(${JSON.stringify(pattern)},'i');const e=[...document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="menuitem"]')].filter(e=>r.test(e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent?.trim()||'')&&e.getBoundingClientRect().width>0&&!e.disabled);if(e.length!==1)return false;const target=e[0];target.scrollIntoView();const b=target.getBoundingClientRect();const x=b.x+b.width/2,y=b.y+b.height/2;const hit=document.elementFromPoint(x,y);if(!hit||!target.contains(hit))return false;return {x,y}})()`), 'unoccluded page control ' + pattern)
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  close(): void { this.socket.close() }
  diagnostics(): ReadonlyArray<{ kind: string; message: string }> { return [...this.errors] }
  moduleRevisions(): ReadonlyArray<{ path: string; sourceHash: string }> { return [...this.scripts].map(([path, sourceHash]) => ({ path: safeBrowserDiagnostic(path), sourceHash })) }
}

/** Fresh public DSH profiles show a nonbinding notice and optional model setup. Use real UI controls. */
export async function prepareDshPage(cdp: Pick<BrowserCdp, 'evaluate' | 'clickText'>, destination: 'shell' | 'settings' = 'shell'): Promise<void> {
  let acknowledged = false, deferred = false
  await eventually(async () => {
    const target = destination === 'settings' ? 'This computer|本机连接' : 'Settings|设置'
    const page = await cdp.evaluate<{ notice: boolean; model: boolean; ready: boolean; settingsClosed?: boolean }>(`(() => {
      if(!document.body)return {notice:false,model:false,ready:false};
      const t=document.body.innerText, controls=[...document.querySelectorAll('button,a,[role="button"],[role="tab"]')];
      const label=e=>e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent?.trim()||'';
      const hit=e=>{const b=e?.getBoundingClientRect();return !!(e&&b&&b.width>0&&b.height>0&&e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)))};
      const e=controls.find(e=>new RegExp(${JSON.stringify('^(' + target + ')$')},'i').test(label(e))&&hit(e));
      const settings=controls.find(e=>/^(Settings|设置)$/i.test(label(e))&&hit(e));
      return {notice:/Internal Testing Notice|内测声明/.test(t),model:/Add an API key to get started|添加一个 API Key 开始使用/.test(t),
        ready:!!e,settingsClosed:!!settings&&settings.getAttribute('aria-expanded')==='false'};
    })()`)
    if (page.notice) { if (!acknowledged) { await cdp.clickText('^(Continue|继续)$'); acknowledged = true }; return false }
    if (page.model) { if (!deferred) { await cdp.clickText('^(Configure later|稍后配置)$'); deferred = true }; return false }
    if (destination === 'settings' && page.settingsClosed && !page.ready) { await cdp.clickText('^(Settings|设置)$'); return false }
    return page.ready
  }, 'normal DSH notice and optional model onboarding')
}
