/**
 * Desktop integration plugin: task-state reminders through the desktop shell
 * bridge. Pure presentation — it observes existing client state and events,
 * adds no session event and no model-visible input. Without
 * `window.desktopBridge` (a plain browser) every action is a silent no-op.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Service and declaration merges consumed by this plugin.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { getDesktopBridge, type DesktopWindowState } from './bridge.ts'
import { en, NS, zh, type DesktopIntegrationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop integration reminder copy. */
    'desktop-integration': DesktopIntegrationKey
  }
}

/** Services required by the plugin. */
export const inject = ['sessions', 'remote', 'uiSession', 'locale']

/** Desktop reminder strategy. */
export interface Config {
  /** Master switch; when false the plugin contributes nothing. */
  enabled?: boolean
  /** Remind only while the shell window is not focused. */
  unfocusedOnly?: boolean
  /** Minimum client-observed run duration (ms) before a completion reminds. */
  completionMinDurationMs?: number
  /** Skip a same-category, same-session reminder within this window (ms). */
  dedupeWindowMs?: number
  /** Local quiet hours; no reminder inside the half-open interval. */
  quietHours?: { startHour: number; endHour: number } | null
  /** C1: completed-session toast and short flash. */
  notifyOnCompleted?: boolean
  /** C2: persistent taskbar flash while an approval is pending. */
  flashOnApproval?: boolean
  /** C3: failed-turn toast and flash. */
  notifyOnFailure?: boolean
  /** C4: background-job terminal toast and flash. */
  notifyOnJob?: boolean
  /** Completion flash duration (C1/C4 completed), ms. */
  completionFlashMs?: number
  /** Alert flash duration (C3/C4 failed), ms. */
  alertFlashMs?: number
}

/** Validated desktop reminder strategy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  unfocusedOnly: z.boolean().default(true),
  completionMinDurationMs: z.natural().min(0).default(0),
  dedupeWindowMs: z.natural().min(0).default(5_000),
  quietHours: z.union([z.object({
    startHour: z.natural().max(23),
    endHour: z.natural().max(24),
  }), z.const(null)]).default(null),
  notifyOnCompleted: z.boolean().default(true),
  flashOnApproval: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(true),
  notifyOnJob: z.boolean().default(true),
  completionFlashMs: z.natural().min(0).default(4_000),
  alertFlashMs: z.natural().min(0).default(8_000),
})

/** Bridge body cap (BODY_MAX in apps/desktop/src/bridge/contract.ts) minus headroom. */
const BODY_PLAIN_MAX = 480

function truncate(value: string): string {
  return value.length <= BODY_PLAIN_MAX ? value : `${value.slice(0, BODY_PLAIN_MAX - 1)}…`
}

/**
 * Mount desktop reminders.
 * @param ctx - Client root context.
 * @param config - validated strategy (schemastery defaults materialized).
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  const cfg = config as Required<Config>
  if (cfg.enabled === false) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-integration: dictionaries')
  const t = ctx.locale.bind(NS)
  const bridge = getDesktopBridge()
  if (bridge === undefined) return

  // Window focus awareness: decisions are edge-triggered, and the shell pushes
  // state transitions plus answers the initial read.
  let windowState: DesktopWindowState = 'focused'
  void bridge.windowState().then((state) => { windowState = state })

  const attentionAllowed = (): boolean => !cfg.unfocusedOnly || windowState !== 'focused'
  const inQuietHours = (): boolean => {
    const range = cfg.quietHours
    // Config arrives from cordis.yml; a missing range means no quiet hours.
    if (range === undefined || range === null) return false
    const hour = new Date().getHours()
    return range.startHour <= range.endHour
      ? hour >= range.startHour && hour < range.endHour
      : hour >= range.startHour || hour < range.endHour
  }
  const lastSent = new Map<string, number>()
  const remindable = (category: string, sessionId: SessionId): boolean => {
    if (inQuietHours()) return false
    const key = `${category}:${sessionId}`
    const now = Date.now()
    if (now - (lastSent.get(key) ?? Number.NEGATIVE_INFINITY) < cfg.dedupeWindowMs) return false
    lastSent.set(key, now)
    return true
  }
  const sendReminder = (input: {
    title: string
    body: string
    urgency: 'low' | 'normal' | 'critical'
    flashMs: number
    category: string
    sessionId: SessionId
  }): void => {
    if (!remindable(input.category, input.sessionId)) return
    void bridge.notify({ title: input.title, body: input.body, urgency: input.urgency })
      .catch((error: unknown) => {
        // The bridge rejects only invalid payloads or a vanished shell; the
        // payload here is locally validated, so a rejection is a shell-side
        // failure worth surfacing on the console.
        console.warn('[desktop-integration] notify rejected by the shell:', error)
      })
    void bridge.flash({ kind: 'duration', ms: input.flashMs })
      .catch((error: unknown) => {
        // Same contract as notify: locally validated payload, shell-side failure.
        console.warn('[desktop-integration] flash rejected by the shell:', error)
      })
  }

  const titleOf = (sessionId: SessionId): string =>
    ctx.sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId

  // C1 · completed sessions: list-row `completed` false→true edges (G1). The
  // provider's own first-observation rule is mirrored: an already-completed row
  // present at mount arms no reminder.
  const completedBefore = new Map<SessionId, boolean>()
  const runningSince = new Map<SessionId, number>()
  const reconcileList = (): void => {
    const snapshot = ctx.sessions.list.getSnapshot()
    const now = Date.now()
    for (const row of Object.values(snapshot.byId)) {
      const id = row.id
      if (row.running && !runningSince.has(id)) runningSince.set(id, now)
      const runMs = runningSince.get(id) === undefined ? 0 : now - (runningSince.get(id) ?? now)
      const prev = completedBefore.get(id)
      const completed = row.completed === true
      completedBefore.set(id, completed)
      // First observation is a baseline only (the host reminder has the same
      // rule); later false→true edges arm the completion reminder.
      if (prev !== undefined && completed && !prev && cfg.notifyOnCompleted && attentionAllowed()
        && runMs >= cfg.completionMinDurationMs) {
        sendReminder({
          title: t('completed.title'),
          body: t('completed.body', { title: row.displayTitle }),
          urgency: 'normal',
          flashMs: cfg.completionFlashMs,
          category: 'completed',
          sessionId: id,
        })
      }
      if (!row.running) runningSince.delete(id)
    }
    for (const id of [...completedBefore.keys()]) {
      if (snapshot.byId[id] === undefined) completedBefore.delete(id)
    }
    for (const id of [...runningSince.keys()]) {
      if (snapshot.byId[id] === undefined) runningSince.delete(id)
    }
  }

  // C4 · background jobs: `jobsBySession` mirror transitions (G4).
  const jobStatus = new Map<string, SessionJob['status']>()
  const reconcileJobs = (): void => {
    const snapshot = ctx.sessions.list.getSnapshot()
    const seen = new Set<string>()
    for (const sessionId of Object.keys(snapshot.jobsBySession) as SessionId[]) {
      for (const job of snapshot.jobsBySession[sessionId] ?? []) {
        const key = `${sessionId}:${job.id}`
        seen.add(key)
        const prev = jobStatus.get(key)
        jobStatus.set(key, job.status)
        if (prev === undefined || !cfg.notifyOnJob || !attentionAllowed()) continue
        if (prev === 'running' || prev === 'stopping') {
          if (job.status === 'completed') {
            sendReminder({
              title: t('job.completed.title'),
              body: t('job.completed.body', { label: job.label, title: titleOf(sessionId) }),
              urgency: 'normal',
              flashMs: cfg.completionFlashMs,
              category: `job:${job.id}`,
              sessionId,
            })
          } else if (job.status === 'failed' || job.status === 'killed') {
            const keys = job.status === 'failed' ? ['job.failed.title', 'job.failed.body'] as const
              : ['job.killed.title', 'job.killed.body'] as const
            sendReminder({
              title: t(keys[0]),
              body: t(keys[1], { label: job.label, title: titleOf(sessionId) }),
              urgency: job.status === 'failed' ? 'critical' : 'normal',
              flashMs: cfg.alertFlashMs,
              category: `job:${job.id}`,
              sessionId,
            })
          }
        }
      }
    }
    for (const key of [...jobStatus.keys()]) {
      if (!seen.has(key)) jobStatus.delete(key)
    }
  }

  // C2 · pending approvals: `uiSession.pendingInteractions` presence (G2).
  const pendingKeys = new Set<string>()
  const reconcilePending = (): void => {
    const snapshot = ctx.uiSession.pendingInteractions.getSnapshot()
    const next = new Set(
      [...snapshot.values()].filter(interaction => interaction.kind === 'approval').map(i => i.key),
    )
    if (next.size === pendingKeys.size && [...next].every(key => pendingKeys.has(key))) return
    pendingKeys.clear()
    for (const key of next) pendingKeys.add(key)
    if (next.size > 0) {
      if (cfg.flashOnApproval && attentionAllowed() && !inQuietHours()) {
        void bridge.flash({ kind: 'until-focus' }).catch((error: unknown) => {
          console.warn('[desktop-integration] approval flash rejected by the shell:', error)
        })
      }
    } else {
      void bridge.flashClear().catch(() => {
        // flashClear after the pending set emptied; a rejection leaves a stale
        // flash the next focus clears anyway (the shell clears on focus).
      })
    }
  }

  // C3 · failed turns: the global `api-session/error` forward (G3).
  const onSessionError = (sessionId: SessionId, message: string): void => {
    if (!cfg.notifyOnFailure || !attentionAllowed()) return
    sendReminder({
      title: t('failure.title'),
      body: t('failure.body', { title: titleOf(sessionId), message: truncate(message) }),
      urgency: 'critical',
      flashMs: cfg.alertFlashMs,
      category: 'failure',
      sessionId,
    })
  }

  ctx.effect(() => {
    const disposeState = bridge.onWindowState((state) => { windowState = state })
    const disposeList = ctx.sessions.list.subscribe(reconcileList)
    const disposeJobs = ctx.sessions.list.subscribe(reconcileJobs)
    const disposePending = ctx.uiSession.pendingInteractions.subscribe(reconcilePending)
    const disposeError = ctx.remote.$on('api-session/error', onSessionError)
    return () => {
      disposeState()
      disposeList()
      disposeJobs()
      disposePending()
      disposeError()
    }
  }, 'desktop-integration: subscriptions')
}