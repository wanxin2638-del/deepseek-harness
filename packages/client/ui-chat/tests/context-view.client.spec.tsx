// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEventSource, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionContextValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ContextView } from '../src/client/context/ContextView.tsx'
import { en, zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)
const tEn = makeTranslate(en, commonEn)

function eventSource() {
  let revision = 0
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => ({ revision }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as unknown as SessionEventSource,
    advance: () => {
      revision++
      for (const listener of listeners) listener()
    },
  }
}

function contextValue(text = 'hello'): SessionContextValue {
  return {
    asOfSeq: 4,
    header: {
      config: { provider: 'fixture', model: 'fixture-model' },
      system: 'system prompt',
      tools: [],
    },
    messages: [{
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      id: 'message-1' as never,
    }],
  }
}

function renderContext(
  readContext: SessionFace['readContext'],
  source: SessionEventSource,
  translate: typeof t = t,
) {
  const View = ContextView as unknown as ComponentType<{
    session: SessionFace
    eventSource: SessionEventSource
    t: typeof t
  }>
  return render(<View
    session={{ readContext } as unknown as SessionFace}
    eventSource={source}
    t={translate}
  />)
}

describe('ContextView', () => {
  it('renders the Host context and refreshes after a durable event revision', async () => {
    const feed = eventSource()
    const readContext = vi.fn<SessionFace['readContext']>()
      .mockResolvedValueOnce({ ok: true, value: contextValue('first') })
      .mockResolvedValueOnce({ ok: true, value: contextValue('second') })
    const view = renderContext(readContext, feed.source)

    await waitFor(() => { expect(view.container.textContent).toContain('system prompt') })
    expect(readContext).toHaveBeenCalledTimes(1)

    act(() => { feed.advance() })
    await waitFor(() => { expect(readContext).toHaveBeenCalledTimes(2) })
  })

  it('renders an English read failure', async () => {
    const feed = eventSource()
    const readContext = vi.fn<SessionFace['readContext']>()
      .mockResolvedValue({ ok: false, error: new Error('unavailable') as never })
    const view = renderContext(readContext, feed.source, tEn)

    await waitFor(() => { expect(view.getByText('Context read failed: unavailable')).toBeTruthy() })
  })
})
