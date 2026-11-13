/** Minimal CDP transport for real headed browser tests; no TLS or protocol prompt suppression. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function eventually<T>(read: () => Promise<T | undefined | false>, label: string, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined && result !== false) return result
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Deadline: ${label}`)
}
export class BrowserCdp {
  private id = 0
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown }
      if (!message.id) return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id); clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error('CDP command failed')); else entry.resolve(message.result)
    })
    socket.addEventListener('close', () => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('CDP closed')) }; this.pending.clear() })
  }
  static async page(profile: string): Promise<BrowserCdp> {
    const port = await eventually(async () => {
      try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || undefined } catch { return undefined }
    }, 'owned browser debugging endpoint')
    const target = await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
      const rows = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>
      return rows.find(row => row.type === 'page')
    }, 'browser page')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Cannot open browser CDP')), { once: true }) })
    return new BrowserCdp(socket)
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
}

/** Fresh public DSH profiles show a nonbinding notice and optional model setup. Use real UI controls. */
export async function prepareDshPage(cdp: Pick<BrowserCdp, 'evaluate' | 'clickText'>): Promise<void> {
  let acknowledged = false, deferred = false
  await eventually(async () => {
    const page = await cdp.evaluate<{ notice: boolean; model: boolean; ready: boolean }>(`(() => {const t=document.body.innerText;const e=[...document.querySelectorAll('button,a,[role="button"]')].find(e=>/^(Settings|设置)$/i.test(e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent?.trim()||''));const b=e?.getBoundingClientRect();return {notice:/Internal Testing Notice|内测声明/.test(t),model:/Add an API key to get started|添加一个 API Key 开始使用/.test(t),ready:!!(e&&b&&e.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)))}})()`)
    if (page.notice) { if (!acknowledged) { await cdp.clickText('^(Continue|继续)$'); acknowledged = true }; return false }
    if (page.model) { if (!deferred) { await cdp.clickText('^(Configure later|稍后配置)$'); deferred = true }; return false }
    return page.ready
  }, 'normal DSH notice and optional model onboarding')
}
