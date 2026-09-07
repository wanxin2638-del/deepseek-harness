/**
 * Taskbar flash state machine. Two modes share one rule: window focus clears
 * every flash (the user came back to the window; D4). `until-focus` has no
 * timer and persists until focus or an explicit clear; `duration` self-clears
 * after `ms`. A newer flash supersedes the active one.
 */

export class FlashController {
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param setFlash - main-side `win.flashFrame(flag)` adapter.
   */
  constructor(private readonly setFlash: (active: boolean) => void) {}

  /** Flash until window focus or {@link clear}. */
  untilFocus(): void {
    this.apply(true, undefined)
  }

  /** Flash for `ms`, then clear; a newer call restarts the window. */
  duration(ms: number): void {
    const timer = setTimeout(() => { this.clear() }, ms)
    this.apply(true, timer)
  }

  /** Stop flashing and drop any pending duration timer. */
  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.setFlash(false)
  }

  /** Window focus reaches the shell: always stop flashing (D4). */
  focus(): void {
    this.clear()
  }

  dispose(): void {
    this.clear()
  }

  private apply(active: boolean, timer: ReturnType<typeof setTimeout> | undefined): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = timer
    this.setFlash(active)
  }
}
