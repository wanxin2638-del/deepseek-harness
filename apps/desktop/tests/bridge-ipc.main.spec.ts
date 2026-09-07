/**
 * Bridge IPC wiring: sender whitelist, request dispatch, response shapes, the
 * focus auto-clear, and disposal — against a mocked electron ipcMain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories hoist above imports, so the spy refs must come from
// vi.hoisted to avoid the temporal-dead-zone error at module evaluation.
const { handle, removeHandler } = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle, removeHandler },
  Notification: class {
    static isSupported(): boolean { return true }
    show(): void {}
  },
}))

import { installDesktopBridge, windowStateOf, type DesktopBridgeHost } from '../src/bridge/index.ts'
import { BRIDGE_CHANNEL } from '../src/bridge/contract.ts'
import type { IpcMainInvokeEvent } from 'electron'

function fakeHost(overrides: Partial<DesktopBridgeHost> = {}): DesktopBridgeHost & {
  flashes: boolean[]
  focusListeners: Array<() => void>
} {
  const flashes: boolean[] = []
  const focusListeners: Array<() => void> = []
  return {
    windowState: () => 'visible-unfocused' as const,
    flashFrame: flag => { flashes.push(flag) },
    notify: () => true,
    send: () => {},
    onWindowFocus: (listener) => {
      focusListeners.push(listener)
      return () => { focusListeners.splice(focusListeners.indexOf(listener), 1) }
    },
    flashes,
    focusListeners,
    ...overrides,
  }
}

function fakeEvent(url: string): IpcMainInvokeEvent {
  return {
    senderFrame: { url },
    sender: { getURL: () => url },
  } as unknown as IpcMainInvokeEvent
}

function registeredHandler(): (event: IpcMainInvokeEvent, payload: unknown) => unknown {
  const call = handle.mock.calls.find(([channel]) => channel === BRIDGE_CHANNEL)
  if (call === undefined) throw new Error('bridge handler was not registered')
  return call[1] as (event: IpcMainInvokeEvent, payload: unknown) => unknown
}

beforeEach(() => {
  handle.mockClear()
  removeHandler.mockClear()
})

describe('installDesktopBridge', () => {
  it('registers one handler on the bridge channel', () => {
    installDesktopBridge(fakeHost())
    expect(handle).toHaveBeenCalledWith(BRIDGE_CHANNEL, expect.any(Function))
  })

  it('rejects callers that are not loopback pages', async () => {
    installDesktopBridge(fakeHost())
    const result = await registeredHandler()(fakeEvent('https://evil.example/'), { op: 'windowState' })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('loopback') })
  })

  it('dispatches notify, flash, flashClear, and windowState to the host', async () => {
    const host = fakeHost()
    installDesktopBridge(host)
    const handler = registeredHandler()
    expect(await handler(fakeEvent('http://127.0.0.1:3080/'), {
      op: 'notify',
      input: { title: 't', body: 'b', urgency: 'critical' },
    })).toMatchObject({ ok: true, shown: true })
    expect(host.flashes).toHaveLength(0)

    await handler(fakeEvent('http://127.0.0.1:3080/'), { op: 'flash', mode: { kind: 'until-focus' } })
    expect(host.flashes).toEqual([true])
    await handler(fakeEvent('http://127.0.0.1:3080/'), { op: 'flash', mode: { kind: 'duration', ms: 3000 } })
    expect(host.flashes).toEqual([true, true])
    await handler(fakeEvent('http://127.0.0.1:3080/'), { op: 'flashClear' })
    expect(host.flashes).toEqual([true, true, false])

    expect(await handler(fakeEvent('http://127.0.0.1:3080/'), { op: 'windowState' }))
      .toMatchObject({ ok: true, state: 'visible-unfocused' })
  })

  it('rejects invalid payloads before touching the host', async () => {
    const host = fakeHost()
    installDesktopBridge(host)
    const result = await registeredHandler()(fakeEvent('http://127.0.0.1:3080/'), {
      op: 'flash',
      mode: { kind: 'duration', ms: -5 },
    })
    expect(result).toMatchObject({ ok: false, error: expect.any(String) })
    expect(host.flashes).toHaveLength(0)
  })

  it('window focus clears the flash (D4: focus always stops flashing)', async () => {
    const host = fakeHost()
    installDesktopBridge(host)
    const handler = registeredHandler()
    await handler(fakeEvent('http://127.0.0.1:3080/'), { op: 'flash', mode: { kind: 'until-focus' } })
    expect(host.flashes).toEqual([true])
    const focus = host.focusListeners[0]
    expect(focus).toBeDefined()
    focus!()
    expect(host.flashes).toEqual([true, false])
  })

  it('dispose removes the handler and focus listener', async () => {
    const host = fakeHost()
    const dispose = installDesktopBridge(host)
    dispose()
    expect(removeHandler).toHaveBeenCalledWith(BRIDGE_CHANNEL)
    expect(host.focusListeners).toHaveLength(0)
  })
})

describe('windowStateOf', () => {
  it('maps Electron window facts to the four states', () => {
    const win = (visible: boolean, minimized: boolean, focused: boolean) => ({
      isVisible: () => visible,
      isMinimized: () => minimized,
      isFocused: () => focused,
    })
    expect(windowStateOf(win(true, false, true))).toBe('focused')
    expect(windowStateOf(win(true, false, false))).toBe('visible-unfocused')
    expect(windowStateOf(win(true, true, false))).toBe('minimized')
    expect(windowStateOf(win(false, false, false))).toBe('hidden')
  })
})