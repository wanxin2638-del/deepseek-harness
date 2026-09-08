/** Displays the Host-reconstructed model context for the selected Session. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionEventSource, SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionContextValue } from '@deepseek-ai/dsh-api-session-controller/types'
import { JsonTree, type JsonTreeLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ContextView.module.css'

/** Session-owned data needed by the Context view. */
export interface ContextViewInjected {
  /** Client Session whose Host context is being inspected. */
  readonly session: SessionFace
  /** Durable event window used to refresh the point-in-time read. */
  readonly eventSource: SessionEventSource
}

type ContextState =
  | { readonly status: 'loading'; readonly value?: SessionContextValue }
  | { readonly status: 'ready'; readonly value: SessionContextValue }
  | { readonly status: 'error'; readonly message: string; readonly value?: SessionContextValue }

function jsonTreeLabels(t: PropsLocale<'chat'>['t']): JsonTreeLabels {
  return {
    copyValue: t('json.copyValue'),
    copyJson: t('json.copyJson'),
    copyPath: t('json.copyPath'),
    copyPrettyJson: t('json.copyPrettyJson'),
    copyCompactJson: t('json.copyCompactJson'),
    copied: t('json.copied'),
    copyFailed: t('json.copyFailed'),
    collapseNode: t('json.collapseNode'),
    expandNode: t('json.expandNode'),
    copyButtonTitle: action => t('json.copyButtonTitle', { action }),
  }
}

/** Render the exact Host-derived request header and message history as JSON. */
export function ContextView({ session, eventSource, t }: ConvViewProps
  & InjectFace<ContextViewInjected>
  & PropsLocale<'chat'>) {
  const revision = useSyncExternalStore(
    listener => eventSource.subscribe(listener),
    () => eventSource.getSnapshot().revision,
    () => eventSource.getSnapshot().revision,
  )
  const [state, setState] = useState<ContextState>({ status: 'loading' })
  const requestGeneration = useRef(0)
  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const generation = ++requestGeneration.current
    setState(current => ({ status: 'loading', ...(current.value === undefined ? {} : { value: current.value }) }))
    try {
      const result = await session.readContext(signal)
      if (generation !== requestGeneration.current) return
      if (!result.ok) {
        setState(current => ({ status: 'error', message: result.error.message, ...current.value === undefined ? {} : { value: current.value } }))
        return
      }
      setState({ status: 'ready', value: result.value })
    } catch (error: unknown) {
      if (generation !== requestGeneration.current) return
      setState(current => ({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        ...current.value === undefined ? {} : { value: current.value },
      }))
    }
  }, [session])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => {
      controller.abort()
      requestGeneration.current++
    }
  }, [refresh, revision])

  const labels = useMemo(() => jsonTreeLabels(t), [t])
  const value = state.value
  const data = value === undefined
    ? undefined
    : { asOfSeq: value.asOfSeq, header: value.header, messages: value.messages }

  return (
    <div className={css.root} data-context-view>
      <div className={css.toolbar}>
        <span className={css.title}>{t('context.title')}</span>
        {value !== undefined && (
          <span className={css.position}>{t('context.asOf', { seq: value.asOfSeq })}</span>
        )}
        <button
          className={css.refresh}
          type="button"
          disabled={state.status === 'loading'}
          onClick={() => { void refresh() }}
        >
          {t('context.refresh')}
        </button>
      </div>
      <div className={css.body}>
        {data !== undefined
          ? <JsonTree className={css.tree} data={data} label={t('context.title')} labels={labels} />
          : state.status === 'error'
            ? <p className={`${css.message} ${css.error}`}>{t('context.error', { message: state.message })}</p>
            : <p className={css.message}>{state.status === 'loading' ? t('context.loading') : t('context.empty')}</p>}
      </div>
    </div>
  )
}
