import { app, BrowserWindow, dialog, shell } from 'electron'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembledLaunchSpec, startBackend, systemNodePath, type BackendLaunchSpec, type BackendSession } from './backend.ts'
import { installDesktopBridge, showNotification, windowStateOf } from './bridge/index.ts'
import { BRIDGE_CHANNEL } from './bridge/contract.ts'
import { fileLog, type LogSink } from './log.ts'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const devRuntimeRoot = resolve(repoRoot, 'apps/desktop/.runtime')

function parsePortOverride(argv: string[]): number | undefined {
  const index = argv.indexOf('--port')
  if (index === -1) return undefined
  const raw = argv[index + 1]
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

interface DesktopState {
  session?: BackendSession
  log?: LogSink
  backendLog?: LogSink
}

const state: DesktopState = {}

let quitting = false

/** Set once the backend printed its ready URL; gates the onExit quit path. */
let readyUrl: string | null = null

/** The staged closure in dev (.runtime) or packaged (resources/dsh-runtime), hosted by the matching node runtime (D2). */
function resolveBackendLaunch(portOverride: number | undefined): BackendLaunchSpec {
  const packaged = app.isPackaged
  const runtimeRoot = packaged ? resolve(process.resourcesPath, 'dsh-runtime') : devRuntimeRoot
  // ELECTRON_RUN_AS_NODE is ABI-incompatible with fs-ext (P1.4 probe); the
  // packaged payload ships a standalone node.exe beside the runtime.
  const nodePath = packaged ? resolve(process.resourcesPath, 'node', 'node.exe') : systemNodePath()
  return assembledLaunchSpec(runtimeRoot, nodePath, portOverride ?? 0)
}

function startBackendProcess(portOverride: number | undefined): BackendSession {
  const spec = resolveBackendLaunch(portOverride)
  const session = startBackend({
    spec,
    // F4: DSH_HOME is bootstrap-only; the shell owns it, .env cannot.
    env: { ...process.env, DSH_HOME: resolve(app.getPath('userData'), 'dsh-home') },
    onLog: chunk => state.backendLog?.write(chunk),
    onReady: (url) => {
      readyUrl = url
      const win = BrowserWindow.getAllWindows()[0]
      if (win !== undefined) void win.loadURL(url)
    },
    // Before readiness the backend.ts reject path surfaces the failure dialog;
    // this quit path only fires when a ready backend then dies (crash).
    onExit: () => {
      if (!quitting && readyUrl != null && BrowserWindow.getAllWindows().length > 0) app.quit()
    },
  })
  state.session = session
  return session
}

function failAndQuit(message: string): void {
  dialog.showErrorBox('DeepSeek Harness Desktop', message)
  app.exit(1)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    icon: resolve(app.getAppPath(), 'electron', 'resources', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolve(fileURLToPath(new URL('.', import.meta.url)), 'preload.cjs'),
    },
  })
  win.once('ready-to-show', () => {
    win.show()
  })

  installWindowBridge(win)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLoopback(url)) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isLoopback(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  // win.webContents.openDevTools()
}

/**
 * Install the desktop bridge and push window-state transitions to the page.
 * Cleanup runs after window destruction; native flash calls require a live window.
 * @param win - window that owns the bridge and its listeners.
 */
function installWindowBridge(win: BrowserWindow): void {
  const pushState = () => {
    if (win.webContents.isDestroyed()) return
    win.webContents.send(BRIDGE_CHANNEL, { type: 'window-state', state: windowStateOf(win) })
  }
  // Explicit per-event bindings: Electron's `on` overloads are keyed by
  // literal event names, so a union cannot be dispatched through them.
  win.on('focus', pushState)
  win.on('blur', pushState)
  win.on('minimize', pushState)
  win.on('restore', pushState)
  win.on('show', pushState)
  win.on('hide', pushState)
  const disposeBridge = installDesktopBridge({
    windowState: () => windowStateOf(win),
    flashFrame: (flag) => {
      if (!win.isDestroyed()) win.flashFrame(flag)
    },
    notify: input => showNotification(input),
    send: (channel, payload) => {
      if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload)
    },
    onWindowFocus: (listener) => {
      win.on('focus', listener)
      return () => { win.removeListener('focus', listener) }
    },
  })
  state.log?.write('[main] desktop bridge installed\n')
  win.on('closed', () => {
    win.removeListener('focus', pushState)
    win.removeListener('blur', pushState)
    win.removeListener('minimize', pushState)
    win.removeListener('restore', pushState)
    win.removeListener('show', pushState)
    win.removeListener('hide', pushState)
    disposeBridge()
  })
}

function isLoopback(raw: string): boolean {
  try {
    const host = new URL(raw).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    // Windows toast attribution: without an AppUserModelID the notification
    // center cannot pair toasts to this app (P2.1 risk table).
    app.setAppUserModelId('ai.deepseek.dsh-desktop')
    const logsDir = resolve(app.getPath('userData'), 'logs')
    state.log = fileLog(logsDir, 'main.log')
    state.backendLog = fileLog(logsDir, 'backend.log')
    state.log.write(`[main] desktop shell starting, repo root ${repoRoot}\n`)
    state.log.write(`[main] electron ${process.versions.electron}, node ${process.versions.node}\n`)

    const portOverride = parsePortOverride(process.argv)
    createWindow()

    let session: BackendSession
    try {
      session = startBackendProcess(portOverride)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      state.log.write(`[main] backend startup failed: ${reason}\n`)
      failAndQuit(reason)
      return
    }
    try {
      const url = await session.ready
      state.log.write(`[main] backend ready: ${url}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      state.log.write(`[main] backend readiness failed: ${reason}\n`)
      failAndQuit(reason)
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    state.session?.dispose()
  })
}
