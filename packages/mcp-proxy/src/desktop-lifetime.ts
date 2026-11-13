/** Window visibility and idempotent service shutdown for the desktop owner. */
export interface DesktopSurface { show(): void; hide(): void; focus(): void }
/** Closing a window keeps the service; explicit Exit waits for owned shutdown. */
export class DesktopLifetime {
  private exiting: Promise<void> | undefined
  /** @param surface - native window. @param stop - owned service cleanup. @param quit - final application exit. */
  constructor(private readonly surface: DesktopSurface, private readonly stop: () => Promise<void>, private readonly quit: () => void) {}
  /** Hide without changing background ownership. */
  closeWindow(): void { this.surface.hide() }
  /** Show and focus the existing window. */
  showWindow(): void { this.surface.show(); this.surface.focus() }
  /** @returns one shared shutdown operation, resolving only after the owned service stops. */
  exit(): Promise<void> {
    return this.exiting ??= this.stop().then(() => { this.quit() }, (error: unknown) => {
      this.exiting = undefined
      this.showWindow()
      throw error
    })
  }
}
