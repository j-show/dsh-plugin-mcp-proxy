/** Unified DSH adapter entry; child plugins remain owned by this mounting scope. */
import type { Context, Fiber, FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Host, { type Config as HostConfig } from './host/index.ts'
import * as Agent from './agent/index.ts'
import * as Browser from './browser/index.ts'
import * as Ui from './ui/index.ts'
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** One deployment configuration for the server adapter's internal components. */
export interface Config {
  /** Local connection admission and catalog configuration. */
  readonly host: HostConfig
  /** Session tool projection and sampling configuration. */
  readonly agent?: Agent.Config
  /** Authenticated browser association route configuration. */
  readonly browser?: Browser.Config
  /** Validated when the internal UI component activates. */
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
  const fibers: Fiber[]=[]
  let stopping:Promise<void>|undefined
  const stop=()=>stopping??=Promise.all(fibers.map(fiber=>fiber.dispose())).then(()=>{})
  ctx.effect(()=>stop)
  try {
    const host=ctx.plugin(Host,spec.host);fibers.push(host);await host
    if(host.state!==ACTIVE_STATE)throw new Error('MCP proxy host activation failed')
    const agent=ctx.plugin(Agent,spec.agent);fibers.push(agent);await agent
    if(agent.state!==ACTIVE_STATE)throw new Error('MCP proxy agent activation failed')
    const browser=ctx.plugin(Browser,spec.browser);fibers.push(browser);await browser
    if(browser.state!==ACTIVE_STATE)throw new Error('MCP proxy browser activation failed')
    const parsedUi=await Ui.Config['~standard'].validate(spec.ui)
    if(parsedUi.issues!==undefined)throw new Error('MCP proxy UI configuration invalid: '+JSON.stringify(parsedUi.issues))
    const ui=ctx.plugin(Ui,parsedUi.value as Ui.ProxyUiConfig);fibers.push(ui);await ui
    if(ui.state!==ACTIVE_STATE)throw new Error('MCP proxy UI activation failed')
  } catch(error) { await stop();throw error }
}
