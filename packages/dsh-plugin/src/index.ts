/** Unified DSH adapter entry; child plugins remain owned by this mounting scope. */
import type { Context, FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Host, { type Config as HostConfig } from '@j-show/dsh-mcp-proxy-host'
import * as Agent from '@j-show/dsh-mcp-proxy-agent'
import * as Browser from '@j-show/dsh-mcp-proxy-browser'
import { EntryGroup, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

/** One deployment configuration for the server adapter's internal components. */
export interface Config {
  /** Local connection admission and catalog configuration. */
  readonly host: HostConfig
  /** Session tool projection and sampling configuration. */
  readonly agent?: Agent.Config
  /** Authenticated browser association route configuration. */
  readonly browser?: Browser.Config
  /** Validated by the UI child's schema when its Loader entry activates. */
  readonly ui?: unknown
}
/** Child schemas supply validated defaults and fail on missing deployment configuration. */
export const Config: z<Config> = z.object({ host: Host.Config.required(), agent: Agent.Config, browser: Browser.Config, ui: z.any() })

/** Stable Cordis plugin name. */
export const name = 'mcp-proxy-server'
// ACTIVE is ordinal 2 in the pinned Cordis 4.0.2 const enum, which has no runtime export.
const ACTIVE_STATE: FiberState = 2
/** Existing DSH services required by the adapter. */
export const inject = ['loader', 'webServer', 'credentials', 'connection', 'agents', 'tools', 'systemPrompt']
/**
 * Mount the adapter components as children of one installation entry.
 * @param ctx - parent plugin scope owning every adapter component.
 * @param config - validated host, agent and browser settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const spec = Config(config)
  const parent = ctx.fiber.entry
  if (parent === undefined) throw new Error('MCP proxy server requires a profile Loader entry')
  const group = new EntryGroup(ctx, parent.parent.tree)
  ctx.effect(() => async () => {
    const fibers = group.data.map(entry => group.tree.store[entry.id]?.fiber)
    group.stop()
    await Promise.all(fibers.map(fiber => fiber?.dispose()))
  })
  const children = [
    { name: '@j-show/dsh-mcp-proxy-host', config: spec.host },
    { name: '@j-show/dsh-mcp-proxy-agent', config: spec.agent },
    { name: '@j-show/dsh-mcp-proxy-browser', config: spec.browser },
    { name: '@j-show/dsh-mcp-proxy-ui', config: spec.ui },
  ]
  for (const child of children) {
    const entry: EntryOptions = { ...child, id: group.tree.ensureId({}) }
    group.data.push(entry)
    await group.create(entry)
    const fiber = group.tree.store[entry.id]?.fiber
    await fiber?.inertia
    if (fiber?.state !== ACTIVE_STATE) throw new Error('MCP proxy adapter component activation failed')
  }
}
