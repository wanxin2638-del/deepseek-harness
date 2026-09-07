/**
 * Sandboxed preload: exposes the desktop bridge as `window.desktopBridge`.
 * Must stay CommonJS — sandboxed preload scripts cannot use ESM. The built
 * `lib/preload.cjs` is copied from this file by scripts/copy-preload.mjs.
 *
 * Wire contract (mirrors apps/desktop/src/bridge/contract.ts):
 * notify({title, body, urgency}) -> Promise<boolean>
 * flash({kind:'until-focus'} | {kind:'duration', ms}) -> Promise<void>
 * flashClear() -> Promise<void>
 * windowState() -> Promise<'focused'|'visible-unfocused'|'minimized'|'hidden'>
 * onWindowState(cb) -> () => void
 */
const { contextBridge, ipcRenderer } = require('electron')

const CHANNEL = 'dsh:desktop-bridge'

function invoke(payload) {
  return ipcRenderer.invoke(CHANNEL, payload)
}

function requireOk(result) {
  if (!result.ok) throw new Error(result.error)
  return result
}

contextBridge.exposeInMainWorld('desktopBridge', {
  notify(input) {
    return invoke({ op: 'notify', input }).then(requireOk).then(result => result.shown)
  },
  flash(mode) {
    return invoke({ op: 'flash', mode }).then(requireOk)
  },
  flashClear() {
    return invoke({ op: 'flashClear' }).then(requireOk)
  },
  windowState() {
    return invoke({ op: 'windowState' }).then(requireOk).then(result => result.state)
  },
  onWindowState(callback) {
    const listener = (_event, payload) => {
      if (payload !== null && typeof payload === 'object' && payload.type === 'window-state') {
        callback(payload.state)
      }
    }
    ipcRenderer.on(CHANNEL, listener)
    return () => { ipcRenderer.removeListener(CHANNEL, listener) }
  },
})