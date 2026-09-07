/**
 * Renderer-side mirror of the desktop shell bridge
 * (apps/desktop/src/bridge/contract.ts). The shell preload exposes
 * `window.desktopBridge`; a plain browser environment carries no such global,
 * and every caller treats its absence as a silent no-op (D6).
 */

/** Shell window focus state pushed to the plugin; the shell's own classification. */
export type DesktopWindowState = 'focused' | 'visible-unfocused' | 'minimized' | 'hidden'

/** Toast payload accepted by the shell bridge; title/body length caps live on the main side. */
export interface DesktopNotifyInput {
  readonly title: string
  readonly body: string
  readonly urgency: 'low' | 'normal' | 'critical'
}

/** Taskbar flash request: hold until the window regains focus, or run for a fixed duration. */
export type DesktopFlashMode =
  | { readonly kind: 'until-focus' }
  | { readonly kind: 'duration'; readonly ms: number }

/** The shell's three-primitive surface (notify / flash / window state). */
export interface DesktopBridge {
  notify(input: DesktopNotifyInput): Promise<boolean>
  flash(mode: DesktopFlashMode): Promise<void>
  flashClear(): Promise<void>
  windowState(): Promise<DesktopWindowState>
  onWindowState(callback: (state: DesktopWindowState) => void): () => void
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge
  }
}

/**
 * Read the bridge global; undefined outside the desktop shell.
 * @returns the desktop shell bridge, or undefined in a plain browser.
 */
export function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.desktopBridge
}
