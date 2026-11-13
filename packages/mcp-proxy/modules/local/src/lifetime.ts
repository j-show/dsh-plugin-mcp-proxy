/** One owner for SDK transport shutdown and cancellation quarantine. */
interface ClientOwner {
  onclose?: () => void
  readonly transport?: unknown
  close(): Promise<void>
}

interface TransportOwner { close(): Promise<void> }

/** Share one SDK close barrier between parent cancellation, call settlement and pool teardown. */
export class DriverLifetime {
  private live = false
  private closing: Promise<void> | undefined

  /** @param client - SDK protocol owner. @param transport - transport retained during startup. */
  constructor(private readonly client: ClientOwner, private readonly transport: TransportOwner) {
    client.onclose = () => { this.live = false }
  }

  /**
   * Report whether the downstream client is still connected.
   * @returns whether the attached SDK generation may receive new operations.
   */
  get connected(): boolean { return this.live && this.closing === undefined }

  /** Mark a successfully attached generation ready; a closed startup cannot become live. */
  ready(): void {
    if (this.closing !== undefined || this.client.transport === undefined) throw new Error('Local MCP closed during startup')
    this.live = true
  }

  /**
   * Keep callback ownership until SDK work and any cancellation-triggered close settle.
   * @param signal - exact parent operation lifetime.
   * @param work - SDK operation under the service's serialized lane.
   * @param cancel - optional independently bounded protocol cleanup before retiring the transport.
   * @returns the operation result; cancelling retires this client generation.
   */
  async run(signal: AbortSignal, work: () => Promise<unknown>, cancel?: () => Promise<void>): Promise<unknown> {
    const retire = (): void => {
      // The finally block and pool teardown observe the retained close promise.
      void this.close(cancel).catch((_error: unknown) => {})
    }
    signal.addEventListener('abort', retire, { once: true })
    try {
      signal.throwIfAborted()
      return await work()
    } catch (error) {
      await this.close(cancel)
      throw error
    } finally {
      signal.removeEventListener('abort', retire)
      if (this.closing !== undefined) await this.closing
    }
  }

  /**
   * Close the owned transport and wait for downstream shutdown.
   * @param cancel - independently bounded task cleanup, if an operation is still pending.
   * @returns the single shutdown barrier for protocol cleanup and the serving SDK transport.
   */
  close(cancel?: () => Promise<void>): Promise<void> {
    this.live = false
    return this.closing ??= (async () => {
      if (cancel !== undefined) {
        try { await cancel() } catch (_error) {
          // Failed task cancellation leaves its outcome unknown; transport retirement must still finish.
        }
      }
      if (this.client.transport !== undefined) await this.client.close()
      else await this.transport.close()
    })()
  }
}
