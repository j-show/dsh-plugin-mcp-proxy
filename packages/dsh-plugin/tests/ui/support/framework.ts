/** Test access to public DSH browser factories, without workspace-only source imports. */
import { publishedClient } from './published-client.ts'

export const { LocaleRuntime } = publishedClient<typeof import('@deepseek-ai/dsh-client-locale/client')>(
  '@deepseek-ai/dsh-client-locale/client')
export const { SlotRegistry } = publishedClient<typeof import('@deepseek-ai/dsh-client-ui-renderer/client')>(
  '@deepseek-ai/dsh-client-ui-renderer/client')
