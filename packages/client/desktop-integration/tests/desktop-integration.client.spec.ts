// @vitest-environment jsdom
/**
 * Desktop integration plugin: trigger→bridge mapping over the real client
 * test runtime (real Cordis ctx, real ui-session, TestSessions list double),
 * plus the no-bridge no-op and HMR disposal contracts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fiber } from '@deepseek-ai/cordis'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, stubSettingsScope, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, Config, inject } from '../src/client/index.ts'
import type {
  DesktopBridge,
  DesktopFlashMode,
  DesktopNotifyInput,
  DesktopWindowState,
} from '../src/client/bridge.ts'
import { en, NS, zh } from '../src/client/locales.ts'

type BridgeCall =
  | { op: 'notify'; input: DesktopNotifyInput }
  | { op: 'flash'; mode: DesktopFlashMode }
  | { op: 'flashClear' }

/** Recording bridge double; the window state is set before mounting. */
class FakeBridge implements DesktopBridge {
  readonly calls: BridgeCall[] = []
  windowStateValue: DesktopWindowState = 'visible-unfocused'
  private readonly stateListeners = new Set<(state: DesktopWindowState) => void>()

  // Keep the returned promise unresolved-until-listen so callers observe the
  // recorded call synchronously instead of racing microtasks.
  private deferred(): Promise<void> {
    return Promise.resolve()
  }

  notify(input: DesktopNotifyInput): Promise<boolean> {
    this.calls.push({ op: 'notify', input })
    return Promise.resolve(true)
  }

  flash(mode: DesktopFlashMode): Promise<void> {
    this.calls.push({ op: 'flash', mode })
    return this.deferred()
  }

  flashClear(): Promise<void> {
    this.calls.push({ op: 'flashClear' })
    return this.deferred()
  }

  windowState(): Promise<DesktopWindowState> {
    return Promise.resolve(this.windowStateValue)
  }

  onWindowState(callback: (state: DesktopWindowState) => void): () => void {
    this.stateListeners.add(callback)
    return () => { this.stateListeners.delete(callback) }
  }

  setState(state: DesktopWindowState): void {
    this.windowStateValue = state
    for (const listener of [...this.stateListeners]) listener(state)
  }
}

interface Bench {
  runtime: SlotTestRuntime
  remote: TestRemote
  bridge: FakeBridge | undefined
  fiber: Fiber
  dispose(): Promise<void>
}

async function bench(options: {
  config?: Partial<Config>
  bridgePresent?: boolean
  locale?: 'zh' | 'en'
} = {}): Promise<Bench> {
  // ctx.plugin passes config verbatim (no Loader resolution in this lane), so
  // materialize the schema defaults here, then layer the test overrides.
  const config = Config(options.config ?? {})
  const runtime = await SlotTestRuntime.create()
  const remote = new TestRemote(runtime.ctx)
  // The locale plugin binds a settings scope; the same stubs ui-jobs uses.
  runtime.ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  runtime.ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await runtime.ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  runtime.ctx.locale.setLocale(options.locale ?? 'zh')

  const bridge = options.bridgePresent === false ? undefined : new FakeBridge()
  if (bridge !== undefined) window.desktopBridge = bridge
  const fiber = runtime.ctx.plugin({ inject, apply, Config }, config)
  await fiber.await()
  // The initial bridge.windowState() read resolves in a microtask.
  await Promise.resolve()
  await Promise.resolve()
  return {
    runtime,
    remote,
    bridge,
    fiber,
    dispose: async () => {
      await fiber.dispose()
      await runtime.dispose()
    },
  }
}

function addJob(sessionId: string, job: Partial<SessionJob>): SessionJob {
  return {
    id: `job-${sessionId}` as never,
    kind: 'tool',
    label: '导出报告',
    status: 'running',
    startedAt: 1,
    ...job,
  }
}

/** Build a jobsBySession mirror keyed by branded session ids. */
function jobMap(sessionId: string, jobs: readonly SessionJob[]): SessionListState['jobsBySession'] {
  const map: Record<string, readonly SessionJob[]> = {}
  map[sessionId] = jobs
  return map
}

/** Publish one pending approval interaction through the real ui-session registry. */
function publishApproval(runtime: SlotTestRuntime, key: string, sessionId: string): () => void {
  const publish = runtime.ctx.uiSession.registerPendingInteraction(() => 0)
  return publish({ key, kind: 'approval', sessionId: sessionId as SessionId }, async () => {})
}

function notifyCalls(bridge: FakeBridge | undefined) {
  return bridge?.calls.filter(call => call.op === 'notify').map(call => call.input) ?? []
}

function flashCalls(bridge: FakeBridge | undefined) {
  return bridge?.calls.filter(call => call.op === 'flash').map(call => call.mode) ?? []
}

beforeEach(() => {
  delete window.desktopBridge
})

afterEach(async () => {
  delete window.desktopBridge
})

describe('desktop-integration browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'remote', 'uiSession', 'locale'])
  })

  it('C1: a completed-session edge notifies and flashes when unfocused', async () => {
    const bench_ = await bench()
    try {
      await bench_.runtime.sessions.add({
        id: 's1',
        summary: { title: '写文档', displayTitle: '写文档', running: true },
      }, { current: false })
      await bench_.runtime.sessions.updateSummary('s1', { running: false, completed: true })
      expect(notifyCalls(bench_.bridge)).toEqual([expect.objectContaining({
        title: '任务完成',
        body: '会话「写文档」已完成',
        urgency: 'normal',
      })])
      expect(flashCalls(bench_.bridge)).toEqual([{ kind: 'duration', ms: 4000 }])
    } finally {
      await bench_.dispose()
    }
  })

  it('C1: never reminds on the first observation of an already-completed row', async () => {
    const bench_ = await bench()
    try {
      await bench_.runtime.sessions.add({
        id: 's1',
        summary: { title: '写文档', completed: true },
      }, { current: false })
      await bench_.runtime.sessions.updateSummary('s1', { updatedAt: 99 })
      expect(notifyCalls(bench_.bridge)).toEqual([])
    } finally {
      await bench_.dispose()
    }
  })

  it('C1: skips while the window is focused (unfocusedOnly default)', async () => {
    const bench_ = await bench()
    try {
      await bench_.runtime.sessions.add({
        id: 's1',
        summary: { title: '写文档', displayTitle: '写文档', running: true },
      }, { current: false })
      bench_.bridge?.setState('focused')
      await bench_.runtime.sessions.updateSummary('s1', { running: false, completed: true })
      expect(notifyCalls(bench_.bridge)).toEqual([])
    } finally {
      await bench_.dispose()
    }
  })

  it('C1: honors completionMinDurationMs', async () => {
    const bench_ = await bench({ config: { completionMinDurationMs: 60_000 } })
    try {
      await bench_.runtime.sessions.add({
        id: 's1',
        summary: { title: '写文档', displayTitle: '写文档', running: true },
      }, { current: false })
      await bench_.runtime.sessions.updateSummary('s1', { running: false, completed: true })
      expect(notifyCalls(bench_.bridge)).toEqual([])
    } finally {
      await bench_.dispose()
    }
  })

  it('C2: an approval pending interaction flashes until-focus, then clears', async () => {
    const bench_ = await bench()
    try {
      const remove = publishApproval(bench_.runtime, 'approval:1', 's1')
      expect(flashCalls(bench_.bridge)).toEqual([{ kind: 'until-focus' }])
      remove()
      expect(bench_.bridge?.calls.at(-1)).toEqual({ op: 'flashClear' })
    } finally {
      await bench_.dispose()
    }
  })

  it('C2: skips the flash while focused and still clears on release', async () => {
    const bench_ = await bench()
    try {
      bench_.bridge?.setState('focused')
      const remove = publishApproval(bench_.runtime, 'approval:2', 's1')
      expect(flashCalls(bench_.bridge)).toEqual([])
      remove()
      expect(bench_.bridge?.calls.at(-1)).toEqual({ op: 'flashClear' })
    } finally {
      await bench_.dispose()
    }
  })

  it('C3: an api-session/error forward notifies critically and flashes', async () => {
    const bench_ = await bench()
    try {
      await bench_.runtime.sessions.add({
        id: 's1',
        summary: { title: '写文档', displayTitle: '写文档' },
      }, { current: false })
      bench_.remote.emit('api-session/error', ['s1', 'provider blew up'])
      expect(notifyCalls(bench_.bridge)).toEqual([expect.objectContaining({
        title: '任务失败',
        body: '会话「写文档」失败：provider blew up',
        urgency: 'critical',
      })])
      expect(flashCalls(bench_.bridge)).toEqual([{ kind: 'duration', ms: 8000 }])
    } finally {
      await bench_.dispose()
    }
  })

  it('C3: dedupes within the dedupe window', async () => {
    const bench_ = await bench({ config: { dedupeWindowMs: 60_000 } })
    try {
      await bench_.runtime.sessions.add({ id: 's1' }, { current: false })
      bench_.remote.emit('api-session/error', ['s1', 'first'])
      bench_.remote.emit('api-session/error', ['s1', 'second'])
      expect(notifyCalls(bench_.bridge)).toHaveLength(1)
    } finally {
      await bench_.dispose()
    }
  })

  it('C3: quiet hours suppress reminders', async () => {
    const hour = new Date().getHours()
    const endHour = hour === 23 ? 24 : hour + 1
    const bench_ = await bench({ config: { quietHours: { startHour: hour, endHour } } })
    try {
      await bench_.runtime.sessions.add({ id: 's1' }, { current: false })
      bench_.remote.emit('api-session/error', ['s1', 'quiet'])
      expect(notifyCalls(bench_.bridge)).toEqual([])
    } finally {
      await bench_.dispose()
    }
  })

  it('C4: a running job that completes notifies once', async () => {
    const bench_ = await bench()
    try {
      await bench_.runtime.sessions.add({
        id: 's1',
        summary: { title: '写文档', displayTitle: '写文档' },
      }, { current: false })
      const running = addJob('s1', { label: '导出报告' })
      bench_.runtime.sessions.list.update((draft) => {
        draft.jobsBySession = jobMap('s1', [running])
      })
      bench_.runtime.sessions.list.update((draft) => {
        draft.jobsBySession = jobMap('s1', [{ ...running, status: 'completed', finishedAt: 2 }])
      })
      expect(notifyCalls(bench_.bridge)).toEqual([expect.objectContaining({
        title: '后台任务完成',
        body: '「导出报告」（会话「写文档」）已完成',
      })])
      // Same terminal status again: no repeated reminder.
      bench_.runtime.sessions.list.update((draft) => {
        draft.jobsBySession = jobMap('s1', [{ ...running, status: 'completed', finishedAt: 3 }])
      })
      expect(notifyCalls(bench_.bridge)).toHaveLength(1)
    } finally {
      await bench_.dispose()
    }
  })

  it('C4: a failed job notifies critically', async () => {
    const bench_ = await bench()
    try {
      await bench_.runtime.sessions.add({ id: 's1' }, { current: false })
      const running = addJob('s1', { label: '导入数据' })
      bench_.runtime.sessions.list.update((draft) => {
        draft.jobsBySession = jobMap('s1', [running])
      })
      bench_.runtime.sessions.list.update((draft) => {
        draft.jobsBySession = jobMap('s1', [{ ...running, status: 'failed', finishedAt: 2 }])
      })
      expect(notifyCalls(bench_.bridge)).toEqual([expect.objectContaining({
        title: '后台任务失败',
        urgency: 'critical',
      })])
    } finally {
      await bench_.dispose()
    }
  })

  it('no bridge: the plugin contributes nothing and nothing throws', async () => {
    const bench_ = await bench({ bridgePresent: false })
    try {
      await bench_.runtime.sessions.add({
        id: 's1',
        summary: { running: true },
      }, { current: false })
      await bench_.runtime.sessions.updateSummary('s1', { running: false, completed: true })
      bench_.remote.emit('api-session/error', ['s1', 'boom'])
      expect(notifyCalls(bench_.bridge)).toEqual([])
    } finally {
      await bench_.dispose()
    }
  })

  it('HMR: fiber disposal removes every subscription', async () => {
    const bench_ = await bench()
    try {
      const { fiber, runtime } = bench_
      await runtime.sessions.add({
        id: 's1',
        summary: { title: '写文档', displayTitle: '写文档', running: true },
      }, { current: false })
      await runtime.sessions.updateSummary('s1', { running: false, completed: true })
      const before = notifyCalls(bench_.bridge).length
      expect(before).toBe(1)
      await fiber.dispose()
      await runtime.sessions.add({
        id: 's2',
        summary: { title: '第二个', running: true },
      }, { current: false })
      await runtime.sessions.updateSummary('s2', { running: false, completed: true })
      bench_.remote.emit('api-session/error', ['s2', 'late failure'])
      publishApproval(bench_.runtime, 'approval:3', 's2')
      expect(notifyCalls(bench_.bridge)).toHaveLength(before)
      expect(bench_.bridge?.calls).toHaveLength(before + 1) // only the initial windowState read
    } finally {
      await bench_.dispose()
    }
  })

  it('copy: zh/en dictionaries are key-identical and the active locale wins', async () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    const english = await bench({ locale: 'en' })
    try {
      await english.runtime.sessions.add({
        id: 's1',
        summary: { title: 'Doc', displayTitle: 'Doc', running: true },
      }, { current: false })
      await english.runtime.sessions.updateSummary('s1', { running: false, completed: true })
      expect(notifyCalls(english.bridge)).toEqual([expect.objectContaining({
        title: 'Task completed',
        body: 'Session "Doc" completed',
      })])
    } finally {
      await english.dispose()
    }
  })

  it('registers the dictionaries under its own namespace', async () => {
    const bench_ = await bench()
    try {
      const translate = bench_.runtime.ctx.locale.bind(NS)
      expect(translate('completed.title')).toBe(zh['completed.title'])
      bench_.runtime.ctx.locale.setLocale('en')
      expect(translate('completed.title')).toBe(en['completed.title'])
    } finally {
      await bench_.dispose()
    }
  })
})
