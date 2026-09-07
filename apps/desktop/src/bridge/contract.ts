/**
 * Desktop bridge wire contract: channel name, renderer-visible value types,
 * and the pure validation used on the main side. No Electron imports — the
 * request parser and origin check are unit-tested directly.
 */

export const BRIDGE_CHANNEL = 'dsh:desktop-bridge'

export type WindowState = 'focused' | 'visible-unfocused' | 'minimized' | 'hidden'

export interface NotifyInput {
  readonly title: string
  readonly body: string
  readonly urgency: 'low' | 'normal' | 'critical'
}

export type FlashMode =
  | { readonly kind: 'until-focus' }
  | { readonly kind: 'duration'; readonly ms: number }

export type BridgeRequest =
  | { readonly op: 'notify'; readonly input: NotifyInput }
  | { readonly op: 'flash'; readonly mode: FlashMode }
  | { readonly op: 'flashClear' }
  | { readonly op: 'windowState' }

export type BridgeResponse =
  | { readonly ok: true; readonly shown?: boolean; readonly state?: WindowState }
  | { readonly ok: false; readonly error: string }

export const TITLE_MAX = 200
export const BODY_MAX = 1000
export const FLASH_DURATION_MAX_MS = 60_000

/** Whether a caller-visible URL belongs to the loopback pages the shell hosts. */
export function isLoopbackOrigin(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return false
  try {
    // URL.hostname keeps IPv6 brackets: `[::1]`.
    const host = new URL(raw).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function isPlainText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
    && !value.includes('<') && !value.includes('>')
}

/**
 * Validate one renderer payload into the typed request union.
 * @param value - raw IPC payload.
 * @returns the parsed request or a caller-visible rejection reason.
 */
export function parseBridgeRequest(
  value: unknown,
): { ok: true; request: BridgeRequest } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'request must be an object' }
  const record = value as Record<string, unknown>
  switch (record.op) {
    case 'notify': {
      const input = record.input
      if (typeof input !== 'object' || input === null) return { ok: false, error: 'notify input must be an object' }
      const { title, body, urgency } = input as Record<string, unknown>
      if (!isPlainText(title, TITLE_MAX)) return { ok: false, error: `title must be plain text up to ${TITLE_MAX} chars` }
      if (!isPlainText(body, BODY_MAX)) return { ok: false, error: `body must be plain text up to ${BODY_MAX} chars` }
      if (urgency !== 'low' && urgency !== 'normal' && urgency !== 'critical') {
        return { ok: false, error: 'urgency must be one of low|normal|critical' }
      }
      return { ok: true, request: { op: 'notify', input: { title, body, urgency } } }
    }
    case 'flash': {
      const mode = record.mode
      if (typeof mode !== 'object' || mode === null) return { ok: false, error: 'flash mode must be an object' }
      const { kind, ms } = mode as { kind?: unknown; ms?: unknown }
      if (kind === 'until-focus') {
        return { ok: true, request: { op: 'flash', mode: { kind: 'until-focus' } } }
      }
      if (kind === 'duration') {
        if (typeof ms !== 'number' || !Number.isFinite(ms)
          || ms < 0 || ms > FLASH_DURATION_MAX_MS) {
          return { ok: false, error: `flash duration ms must be 0..${FLASH_DURATION_MAX_MS}` }
        }
        return { ok: true, request: { op: 'flash', mode: { kind: 'duration', ms } } }
      }
      return { ok: false, error: 'flash kind must be one of until-focus|duration' }
    }
    case 'flashClear':
      return { ok: true, request: { op: 'flashClear' } }
    case 'windowState':
      return { ok: true, request: { op: 'windowState' } }
    default:
      return { ok: false, error: `unknown op ${String(record.op)}` }
  }
}