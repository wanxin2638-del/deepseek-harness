/** Window teardown through the main entry, with Electron and process I/O mocked. */
import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_CHANNEL } from '../src/bridge/contract.ts'

const { createWindow, handle, removeHandler, quit, showMessageBox, trayConstructor } = vi.hoisted(() => {
  const tray = {
    destroy: vi.fn(),
    on: vi.fn(),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
  }
  return {
    createWindow: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
    quit: vi.fn(),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    tray,
    trayConstructor: vi.fn(function () { return tray }),
  }
})

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
    on: vi.fn(),
    whenReady: () => Promise.resolve(),
    quit,
    setAppUserModelId: vi.fn(),
    getAppPath: () => '/desktop-test',
    getPath: () => '/desktop-test',
  },
  BrowserWindow: createWindow,
  ipcMain: { handle, removeHandler },
  Notification: {},
  dialog: { showMessageBox, showErrorBox: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  Tray: trayConstructor,
  shell: {},
}))

vi.mock('../src/backend.ts', () => ({
  assembledLaunchSpec: vi.fn(),
  systemNodePath: () => process.execPath,
  startBackend: () => ({ ready: Promise.resolve('http://127.0.0.1:3080/'), dispose: vi.fn() }),
}))

vi.mock('../src/log.ts', () => ({ fileLog: () => ({ write: vi.fn() }) }))

function fakeWindow() {
  let destroyed = false
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => true,
    focus: vi.fn(),
    hide: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(),
    flashFrame: vi.fn((_flag: boolean) => {
      if (destroyed) throw new TypeError('Object has been destroyed')
    }),
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
    }),
    destroy: () => {
      destroyed = true
      win.emit('closed')
    },
  })
  return win
}

function invoke(payload: unknown): unknown {
  const registration = handle.mock.calls.find(([channel]) => channel === BRIDGE_CHANNEL)
  expect(registration).toBeDefined()
  const handler = registration![1] as (event: IpcMainInvokeEvent, payload: unknown) => unknown
  // Only the sender URL participates in the bridge's origin check.
  const event = { senderFrame: { url: 'http://127.0.0.1:3080/' } } as IpcMainInvokeEvent
  return handler(event, payload)
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('desktop window close', () => {
  it.each(['idle', 'until-focus', 'duration'] as const)(
    'releases the bridge after destroying a window with %s flash state',
    async (mode) => {
      const win = fakeWindow()
      createWindow.mockImplementation(function () { return win })
      await import('../src/main.ts')

      if (mode !== 'idle') {
        expect(invoke({
          op: 'flash',
          mode: mode === 'duration' ? { kind: mode, ms: 4000 } : { kind: mode },
        })).toEqual({ ok: true })
        expect(win.flashFrame).toHaveBeenLastCalledWith(true)
      }
      const flashCalls = win.flashFrame.mock.calls.length
      expect(vi.getTimerCount()).toBe(mode === 'duration' ? 1 : 0)

      expect(() => { win.destroy() }).not.toThrow()

      expect(removeHandler).toHaveBeenCalledWith(BRIDGE_CHANNEL)
      for (const event of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) {
        expect(win.listenerCount(event)).toBe(0)
      }
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(4000)
      expect(win.flashFrame).toHaveBeenCalledTimes(flashCalls)
    },
  )

  it('keeps the bridge and focus clearing active when closing to the tray', async () => {
    const win = fakeWindow()
    createWindow.mockImplementation(function () { return win })
    await import('../src/main.ts')
    const preventDefault = vi.fn()
    win.emit('close', { preventDefault })
    await Promise.resolve()
    await Promise.resolve()

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(showMessageBox).toHaveBeenCalledOnce()
    expect(win.hide).toHaveBeenCalledOnce()
    expect(removeHandler).not.toHaveBeenCalled()
    expect(invoke({ op: 'flash', mode: { kind: 'duration', ms: 4000 } })).toEqual({ ok: true })
    win.emit('focus')
    expect(win.flashFrame.mock.calls).toEqual([[true], [false]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('quits when closing chooses exit', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    const win = fakeWindow()
    createWindow.mockImplementation(function () { return win })
    await import('../src/main.ts')

    const preventDefault = vi.fn()
    win.emit('close', { preventDefault })
    await Promise.resolve()
    await Promise.resolve()

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
    expect(win.hide).not.toHaveBeenCalled()
  })
})
