/**
 * Bridge contract: request validation, origin check, and the flash state
 * machine — all pure logic, no Electron in the loop.
 */
import { describe, expect, it, vi } from 'vitest'
import { FlashController } from '../src/bridge/flash.ts'
import {
  FLASH_DURATION_MAX_MS,
  isLoopbackOrigin,
  parseBridgeRequest,
} from '../src/bridge/contract.ts'

describe('parseBridgeRequest', () => {
  it('accepts a valid notify input', () => {
    const parsed = parseBridgeRequest({
      op: 'notify',
      input: { title: '完成', body: '任务跑完了', urgency: 'normal' },
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.request).toMatchObject({ op: 'notify' })
  })

  it('rejects non-object requests', () => {
    expect(parseBridgeRequest(null).ok).toBe(false)
    expect(parseBridgeRequest('x').ok).toBe(false)
  })

  it('rejects unknown ops', () => {
    expect(parseBridgeRequest({ op: 'teleport' }).ok).toBe(false)
  })

  it('rejects notify payloads with missing, oversized, or tagged fields', () => {
    expect(parseBridgeRequest({ op: 'notify', input: { body: 'b', urgency: 'normal' } }).ok).toBe(false)
    expect(parseBridgeRequest({
      op: 'notify',
      input: { title: 't'.repeat(201), body: 'b', urgency: 'normal' },
    }).ok).toBe(false)
    expect(parseBridgeRequest({
      op: 'notify',
      input: { title: 't', body: 'b'.repeat(1001), urgency: 'normal' },
    }).ok).toBe(false)
    expect(parseBridgeRequest({
      op: 'notify',
      input: { title: '<b>t</b>', body: 'b', urgency: 'normal' },
    }).ok).toBe(false)
    expect(parseBridgeRequest({
      op: 'notify',
      input: { title: 't', body: 'b', urgency: 'urgent' },
    }).ok).toBe(false)
  })

  it('accepts both flash kinds and rejects malformed ones', () => {
    expect(parseBridgeRequest({ op: 'flash', mode: { kind: 'until-focus' } }).ok).toBe(true)
    expect(parseBridgeRequest({ op: 'flash', mode: { kind: 'duration', ms: 4000 } }).ok).toBe(true)
    expect(parseBridgeRequest({ op: 'flash', mode: { kind: 'duration', ms: -1 } }).ok).toBe(false)
    expect(parseBridgeRequest(
      { op: 'flash', mode: { kind: 'duration', ms: FLASH_DURATION_MAX_MS + 1 } },
    ).ok).toBe(false)
    expect(parseBridgeRequest({ op: 'flash', mode: { kind: 'bounce' } }).ok).toBe(false)
  })

  it('accepts flashClear and windowState', () => {
    expect(parseBridgeRequest({ op: 'flashClear' })).toMatchObject({ ok: true })
    expect(parseBridgeRequest({ op: 'windowState' })).toMatchObject({ ok: true })
  })
})

describe('isLoopbackOrigin', () => {
  it('accepts loopback hosts only', () => {
    expect(isLoopbackOrigin('http://127.0.0.1:3080/?token=x')).toBe(true)
    expect(isLoopbackOrigin('http://localhost:1/a')).toBe(true)
    expect(isLoopbackOrigin('http://[::1]:9/')).toBe(true)
    expect(isLoopbackOrigin('https://example.com/')).toBe(false)
    expect(isLoopbackOrigin('file:///C:/x')).toBe(false)
    expect(isLoopbackOrigin(null)).toBe(false)
    expect(isLoopbackOrigin('not a url')).toBe(false)
  })
})

describe('FlashController', () => {
  it('flashes until focus and clears on focus', () => {
    vi.useFakeTimers()
    const setFlash = vi.fn()
    const flash = new FlashController(setFlash)
    flash.untilFocus()
    expect(setFlash).toHaveBeenLastCalledWith(true)
    flash.focus()
    expect(setFlash).toHaveBeenLastCalledWith(false)
    vi.useRealTimers()
  })

  it('clears a duration flash after ms', () => {
    vi.useFakeTimers()
    const setFlash = vi.fn()
    const flash = new FlashController(setFlash)
    flash.duration(4000)
    expect(setFlash).toHaveBeenLastCalledWith(true)
    vi.advanceTimersByTime(4000)
    expect(setFlash).toHaveBeenLastCalledWith(false)
    vi.useRealTimers()
  })

  it('a newer flash supersedes the pending duration timer', () => {
    vi.useFakeTimers()
    const setFlash = vi.fn()
    const flash = new FlashController(setFlash)
    flash.duration(4000)
    flash.untilFocus()
    vi.advanceTimersByTime(4000)
    // The superseded duration timer must not clear the active until-focus flash.
    expect(setFlash).not.toHaveBeenLastCalledWith(false)
    vi.useRealTimers()
  })

  it('explicit clear stops flashing and drops the timer', () => {
    vi.useFakeTimers()
    const setFlash = vi.fn()
    const flash = new FlashController(setFlash)
    flash.duration(4000)
    flash.clear()
    expect(setFlash).toHaveBeenLastCalledWith(false)
    vi.advanceTimersByTime(4000)
    expect(setFlash).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})