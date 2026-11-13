/** Official legacy task execution with one parent lifetime and bounded cancellation cleanup. */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CompatibilityCallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import type { DriverLifetime } from './lifetime.ts'
import type { LocalOptions } from './drivers.ts'
import type { LegacyTaskScope } from './legacy-task-scope.ts'

/**
 * Execute once and return only the final MCP result, preserving ordinary and task-required tools.
 * @param client - serving legacy SDK client.
 * @param lifetime - that client's shutdown owner.
 * @param tool - exact SDK descriptor retained by discovery.
 * @param args - admitted tool JSON arguments.
 * @param signal - original invocation and callback cancellation.
 * @param options - total operation and independent cleanup budgets.
 * @param scope - synchronous task owner attached to the serving transport.
 * @returns the schema-validated final result; creation/status updates never imply success.
 */
export async function callLegacyTool(client: Client, lifetime: DriverLifetime, tool: Tool, args: Record<string, unknown>,
  signal: AbortSignal, options: LocalOptions, scope: LegacyTaskScope): Promise<unknown> {
  scope.begin()
  const deadline = new AbortController()
  const combined = AbortSignal.any([signal, deadline.signal])
  const timer = setTimeout(() => { deadline.abort() }, options.callTimeoutMs)
  timer.unref()
  const cancel = async (): Promise<void> => {
    if (scope.id !== undefined) await client.experimental.tasks.cancelTask(scope.id, { timeout: options.taskCancelTimeoutMs })
  }
  try {
    return await lifetime.run(combined, async () => {
      const stream = client.experimental.tasks.callToolStream({ name: tool.name, arguments: args },
        CompatibilityCallToolResultSchema, { signal: combined, timeout: options.callTimeoutMs,
          ...(tool.execution?.taskSupport === 'required' ? { task: {} } : {}),
        })
      for await (const message of stream) {
        if (message.type === 'taskCreated') {
          if (scope.id !== message.task.taskId) throw new Error('Legacy MCP task creation does not match the transport owner')
        }
        else if (message.type === 'error') throw message.error
        else if (message.type === 'result') {
          if (!message.result.isError && tool.outputSchema !== undefined) {
            if (message.result.structuredContent === undefined) throw new Error('MCP tool output is missing structured content')
            // SDK descriptors are parsed JSON; their optional TypeScript members additionally admit undefined.
            const validate = new AjvJsonSchemaValidator().getValidator(
              tool.outputSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0])
            if (!validate(message.result.structuredContent).valid) throw new Error('MCP tool output does not match its schema')
          }
          return message.result
        }
      }
      throw new Error('MCP tool stream ended without a final result')
    }, cancel)
  } finally { clearTimeout(timer); scope.end() }
}
