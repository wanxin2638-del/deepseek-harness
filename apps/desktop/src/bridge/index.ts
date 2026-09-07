/**
 * Desktop bridge main-side wiring: one IPC channel (`BRIDGE_CHANNEL`) whose
 * requests are sender-whitelisted (loopback pages only) and payload-validated,
 * plus the window-state derivation used by the shell. The channel carries no
 * product semantics — notify/flash/window state are the three primitives.
 */
import { ipcMain, Notification, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  BRIDGE_CHANNEL,
  isLoopbackOrigin,
  parseBridgeRequest,
  type BridgeResponse,
  type NotifyInput,
  type WindowState,
} from './contract.ts'
import { FlashController } from './flash.ts'

/** Everything the bridge needs from the shell, injectable for unit tests. */
export interface DesktopBridgeHost {
  windowState(): WindowState
  flashFrame(flag: boolean): void
  notify(input: NotifyInput): boolean
  send(channel: string, payload: unknown): void
  onWindowFocus(listener: () => void): () => void
}

/**
 * Install the bridge IPC handler for one window.
 * @param host - shell adapters (window state/flash/notification/send).
 * @returns disposer that removes the handler and flash listeners.
 */
export function installDesktopBridge(host: DesktopBridgeHost): () => void {
  const flash = new FlashController((flag) => { host.flashFrame(flag) })
  const disposeFocus = host.onWindowFocus(() => { flash.clear() })
  const handler = (event: IpcMainInvokeEvent, payload: unknown): BridgeResponse => {
    const caller = event.senderFrame?.url ?? event.sender.getURL()
    if (!isLoopbackOrigin(caller)) return { ok: false, error: 'bridge calls require a loopback page origin' }
    const parsed = parseBridgeRequest(payload)
    if (!parsed.ok) return parsed
    switch (parsed.request.op) {
      case 'notify':
        return { ok: true, shown: host.notify(parsed.request.input) }
      case 'flash':
        if (parsed.request.mode.kind === 'until-focus') flash.untilFocus()
        else flash.duration(parsed.request.mode.ms)
        return { ok: true }
      case 'flashClear':
        flash.clear()
        return { ok: true }
      case 'windowState':
        return { ok: true, state: host.windowState() }
    }
  }
  ipcMain.handle(BRIDGE_CHANNEL, handler)
  return () => {
    ipcMain.removeHandler(BRIDGE_CHANNEL)
    disposeFocus()
    flash.dispose()
  }
}

/** Derive the four-state window position from Electron window facts. */
export function windowStateOf(win: Pick<BrowserWindow, 'isVisible' | 'isMinimized' | 'isFocused'>): WindowState {
  if (!win.isVisible()) return 'hidden'
  if (win.isMinimized()) return 'minimized'
  if (win.isFocused()) return 'focused'
  return 'visible-unfocused'
}

/**
 * Show a Windows toast when the platform supports it.
 * @param input - validated notify input.
 * @returns whether a notification was shown.
 */
export function showNotification(input: NotifyInput): boolean {
  if (!Notification.isSupported()) return false
  const notification = new Notification({ title: input.title, body: input.body })
  notification.show()
  return true
}
