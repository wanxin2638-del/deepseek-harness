import { app, BrowserWindow, dialog, shell } from 'electron'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembledLaunchSpec, startBackend, systemNodePath, type BackendLaunchSpec, type BackendSession } from './backend.ts'
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
      const win = BrowserWindow.getAllWindows()[0]
      if (win !== undefined) void win.loadURL(url)
    },
    onExit: () => {
      if (!quitting && BrowserWindow.getAllWindows().length > 0) app.quit()
    },
  })
  state.session = session
  return session
}

async function failAndQuit(message: string): Promise<void> {
  dialog.showErrorBox('DeepSeek Harness Desktop', message)
  app.exit(1)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())

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
    const logsDir = resolve(app.getPath('userData'), 'logs')
    state.log = fileLog(logsDir, 'main.log')
    state.backendLog = fileLog(logsDir, 'backend.log')
    state.log.write(`[main] desktop shell starting, repo root ${repoRoot}\n`)
    state.log.write(`[main] electron ${process.versions.electron}, node ${process.versions.node}\n`)

    const portOverride = parsePortOverride(process.argv)
    createWindow()

    let session: BackendSession
    try {
      session = await startBackendProcess(portOverride)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      state.log.write(`[main] backend startup failed: ${reason}\n`)
      await failAndQuit(reason)
      return
    }
    try {
      const url = await session.ready
      state.log.write(`[main] backend ready: ${url}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      state.log.write(`[main] backend readiness failed: ${reason}\n`)
      await failAndQuit(reason)
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
