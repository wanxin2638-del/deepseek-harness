/** Session-scoped editor for additional sandbox writable directories. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SandboxWritableRoots } from '@deepseek-ai/dsh-sandbox-policy/client'
import { Button, IconCloseOutline16, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AuthorizedPaths.module.css'

/** Host-backed actions used by the current Session's directory editor. */
export interface AuthorizedPathsInjected {
  /** Execute one Session command and report whether the command exists. */
  command: (line: string) => Promise<boolean>
  /** Open the composed Host directory picker. */
  pickDirectory: () => Promise<string | null>
}

/** Full slot props for the additional writable-root editor. */
export type AuthorizedPathsProps =
  PropsRuntime<'conversation.session.header.tabs.trailing'>
  & InjectFace<AuthorizedPathsInjected>
  & PropsLocale<'permission.access'>

/** Render the current Session's additional writable-root editor. */
export function AuthorizedPaths({ useProjection, command, pickDirectory, t }: AuthorizedPathsProps) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const projectedRoots = useProjection('sandboxWritableRoots')
  if (projectedRoots === undefined) return null
  const roots = projectedRoots as SandboxWritableRoots

  const add = async (candidate: string): Promise<void> => {
    const value = candidate.trim()
    if (value.length === 0) {
      setError(t('roots.invalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (!(await command(`/sandbox-path add ${value}`))) throw new Error('command unavailable')
      setPath('')
    } catch {
      setError(t('roots.failed'))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const selected = await pickDirectory()
      if (selected !== null) await add(selected)
    } catch {
      setError(t('roots.failed'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (root: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (!(await command(`/sandbox-path remove ${root}`))) throw new Error('command unavailable')
    } catch {
      setError(t('roots.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={css.trigger}
        aria-label={t('roots.open')}
        title={t('roots.open')}
        onClick={() => { setOpen(true) }}
      >
        {roots.length === 0 ? t('roots.title') : `${t('roots.title')} (${roots.length})`}
      </button>
      <Modal
        open={open}
        className={css.dialog ?? ''}
        title={t('roots.title')}
        description={t('roots.description')}
        closeLabel={t('roots.cancel')}
        onClose={() => { if (!busy) setOpen(false) }}
        footer={(
          <Button variant="ghost" disabled={busy} onClick={() => { setOpen(false) }}>
            {t('roots.cancel')}
          </Button>
        )}
      >
        <div className={css.body}>
          <div className={css.actions}>
            <Input
              value={path}
              placeholder={t('roots.pathPlaceholder')}
              disabled={busy}
              onChange={(event) => { setPath(event.currentTarget.value); setError(null) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void add(path)
              }}
            />
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void add(path) }}>
              {t('roots.add')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void pick() }}>
              {t('roots.pick')}
            </Button>
          </div>
          {error !== null && <div className={css.error} role="alert">{error}</div>}
          {roots.length === 0
            ? <div className={css.empty}>{t('roots.empty')}</div>
            : (
              <ul className={css.list}>
                {roots.map((root: string) => (
                  <li key={root} className={css.item}>
                    <span className={css.path} title={root}>{root}</span>
                    <Button
                      variant="toolbar"
                      size="sm"
                      icon={<IconCloseOutline16 size={14} />}
                      aria-label={`${t('roots.remove')}: ${root}`}
                      title={t('roots.remove')}
                      disabled={busy}
                      onClick={() => { void remove(root) }}
                    />
                  </li>
                ))}
              </ul>
            )}
        </div>
      </Modal>
    </>
  )
}
