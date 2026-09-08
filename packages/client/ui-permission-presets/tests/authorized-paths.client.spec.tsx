// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthorizedPaths } from '../src/client/AuthorizedPaths.tsx'
import { accessZh } from '../src/client/locales.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('AuthorizedPaths', () => {
  it('opens the session directory editor and routes add/remove commands', async () => {
    const command = vi.fn<(line: string) => Promise<boolean>>(() => Promise.resolve(true))
    const View = AuthorizedPaths as unknown as ComponentType<{
      useProjection: (key: string) => readonly string[] | undefined
      command: typeof command
      pickDirectory: () => Promise<string | null>
      t: (key: string) => string
    }>
    render(
      <View
        useProjection={() => ['D:/worktree']}
        command={command}
        pickDirectory={() => Promise.resolve(null)}
        t={key => accessZh[key as keyof typeof accessZh] ?? key}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: accessZh['roots.open'] }))
    expect(screen.getByRole('dialog', { name: accessZh['roots.title'] })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText(accessZh['roots.pathPlaceholder']), {
      target: { value: 'D:/new-worktree' },
    })
    fireEvent.click(screen.getByRole('button', { name: accessZh['roots.add'] }))
    await waitFor(() => { expect(command).toHaveBeenCalledWith('/sandbox-path add D:/new-worktree') })

    fireEvent.click(screen.getByRole('button', { name: `${accessZh['roots.remove']}: D:/worktree` }))
    await waitFor(() => { expect(command).toHaveBeenCalledWith('/sandbox-path remove D:/worktree') })
  })
})
