/** Synchronous wire ownership for one legacy task, before SDK generator continuation. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { CreateTaskResultSchema, type JSONRPCMessage, type RequestId } from '@modelcontextprotocol/sdk/types.js'

/** Opaque task identity validated by the owning legacy SDK schema. */
export type LegacyTaskId = Branded<'LocalMcpTaskId'>
/** Match task creation to its exact outgoing request while one invocation owns the client. */
export class LegacyTaskScope {
  private active = false
  private creation: RequestId | undefined
  private task: LegacyTaskId | undefined
  /** Current task identity, available before callbacks from the same received batch. */
  get id(): LegacyTaskId | undefined { return this.task }
  /** Acquire the serialized invocation's task scope. */
  begin(): void {
    if (this.active) throw new Error('Legacy MCP task scope already active')
    this.active = true
    this.creation = undefined
    this.task = undefined
  }
  /**
   * Track an outgoing request in its legacy task scope.
   * @param message - SDK-generated outgoing request.
   */
  sent(message: JSONRPCMessage): void {
    if (this.active && 'method' in message && message.method === 'tools/call' && 'id' in message
      && message.params?.['task'] !== undefined) this.creation = message.id
  }
  /**
   * Resolve an incoming response in its legacy task scope.
   * @param message - received SDK transport message, before request-handler scheduling.
   */
  received(message: JSONRPCMessage): void {
    if (!this.active || this.creation === undefined || !('result' in message) || message.id !== this.creation) return
    const parsed = CreateTaskResultSchema.safeParse(message.result)
    if (!parsed.success) return
    this.task = parsed.data.task.taskId as LegacyTaskId
    this.creation = undefined
  }
  /** Release only after cancellation cleanup and the operation have settled. */
  end(): void { this.active = false; this.creation = undefined; this.task = undefined }
}
