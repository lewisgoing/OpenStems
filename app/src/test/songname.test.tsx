import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import cases from '../../../engine/tests/fixtures/song_names.json'
import type { Job } from '@/api/client'
import { type JobHandlers, RowMenu, jobMenuItems } from '@/components/RowMenu'
import { SongName } from '@/components/SongName'
import { TooltipProvider } from '@/components/ui'
import { cleanName, fileStem } from '@/lib/songname'
import { renameHint } from '@/views/QueueView'

/* A song's name, typed over in place: what may be typed, the field, and the menu's item. */

describe('what may be typed for a name', () => {
  // The engine's rule (`clean_name`) is tested against the same file.
  for (const one of cases as { typed: string; name?: string | null; error?: string; note: string }[]) {
    it(one.note, () => {
      const typed = cleanName(one.typed)
      if (one.error) expect(typed).toEqual({ ok: false, error: one.error })
      else expect(typed).toEqual({ ok: true, value: one.name })
    })
  }

  it('counts an emoji as one character, as the engine does', () => {
    expect(cleanName('🌙'.repeat(120)).ok).toBe(true)
    expect(cleanName('🌙'.repeat(121)).ok).toBe(false)
  })

  it('knows the name a file goes by', () => {
    expect(fileStem('D:\\in\\y2mate - Song (320).mp3')).toBe('y2mate - Song (320)')
    expect(fileStem('/Users/me/Music/Song.tar.flac')).toBe('Song.tar')
    expect(fileStem('/Users/me/Music/.hidden')).toBe('.hidden')
  })

  it('says what a rename does to stems that are written', () => {
    expect(renameHint(true)).toMatch(/stem folder and its files are renamed/)
    expect(renameHint(false)).toMatch(/will go by this name/)
  })
})

describe('the name of a song, typed over in place', () => {
  const show = (props: Partial<Parameters<typeof SongName>[0]> = {}) => {
    const onRename = vi.fn(async (_name: string | null) => undefined)
    const onError = vi.fn()
    function Row() {
      const [editing, setEditing] = useState(false)
      return (
        <TooltipProvider>
          <div data-testid="row" onClick={() => rowClicks()}>
            <SongName name="y2mate - Song" source="D:\in\y2mate - Song.mp3" editing={editing} onEditing={setEditing} onRename={onRename} onError={onError} hint="Renames the files too." {...props} />
            <button type="button" onClick={() => setEditing(true)}>
              Rename
            </button>
          </div>
        </TooltipProvider>
      )
    }
    const rowClicks = vi.fn()
    render(<Row />)
    const title = () => screen.getByText(/./, { selector: '[data-testid="drag-source"], [data-testid="song-title"]' })
    const field = () => screen.queryByLabelText<HTMLInputElement>('Song name')
    return { onRename, onError, rowClicks, title, field }
  }

  it('opens on a double click with the name selected, and Enter saves what is typed', async () => {
    const { onRename, title, field } = show()
    expect(field()).toBeNull()
    await userEvent.dblClick(title())
    const input = field()
    expect(input).toHaveFocus()
    expect(input?.value).toBe('y2mate - Song')
    // Selected whole: typing replaces it.
    expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, 'y2mate - Song'.length])
    expect(input).toHaveAttribute('title', 'Renames the files too.')

    await userEvent.keyboard('  Night   Drive {Enter}')
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Night Drive')
    expect(field()).toBeNull()
    // Shown at once, before the engine's answer is in the list.
    expect(title()).toHaveTextContent('Night Drive')
  })

  it('opens from its owner (a menu, a key) and saves when the field is left', async () => {
    const { onRename, field } = show()
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(field()).toHaveFocus()
    await userEvent.keyboard('Dusk')
    await userEvent.tab()
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Dusk')
    expect(field()).toBeNull()
  })

  it('Escape puts back what was there and saves nothing', async () => {
    const { onRename, title, field } = show()
    await userEvent.dblClick(title())
    await userEvent.keyboard('Dusk{Escape}')
    expect(field()).toBeNull()
    expect(onRename).not.toHaveBeenCalled()
    expect(title()).toHaveTextContent('y2mate - Song')
  })

  it('saves nothing when the name is the same', async () => {
    const { onRename, title } = show()
    await userEvent.dblClick(title())
    await userEvent.keyboard('{Enter}')
    expect(onRename).not.toHaveBeenCalled()
  })

  it('emptied, the song goes by the name of its file again', async () => {
    const { onRename, title, field } = show({ name: 'Night Drive' })
    await userEvent.dblClick(title())
    await userEvent.clear(field() as HTMLInputElement)
    // The emptied field says what the song will be called.
    expect(field()).toHaveAttribute('placeholder', 'y2mate - Song')
    await userEvent.keyboard('{Enter}')
    expect(onRename).toHaveBeenCalledExactlyOnceWith(null)
    expect(title()).toHaveTextContent('y2mate - Song')
  })

  it('emptied when it already goes by its file, nothing is saved', async () => {
    const { onRename, title, field } = show()
    await userEvent.dblClick(title())
    await userEvent.clear(field() as HTMLInputElement)
    await userEvent.keyboard('{Enter}')
    expect(onRename).not.toHaveBeenCalled()
  })

  it('refuses a name that is none, says why and shows the song again', async () => {
    const { onRename, onError, title } = show()
    await userEvent.dblClick(title())
    await userEvent.keyboard('...{Enter}')
    expect(onError).toHaveBeenCalledWith('A name needs more than dots.')
    expect(onRename).not.toHaveBeenCalled()
    expect(title()).toHaveTextContent('y2mate - Song')
  })

  it('puts the old name back when the engine refuses, and says why', async () => {
    const onRename = vi.fn(async () => {
      throw new Error('a file of this song is open in another program, so nothing was renamed.')
    })
    const { onError, title } = show({ onRename })
    await userEvent.dblClick(title())
    await userEvent.keyboard('Dusk{Enter}')
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('open in another program')))
    expect(title()).toHaveTextContent('y2mate - Song')
  })

  it('keeps its keys and clicks to itself: the row is not opened and Space is not play', async () => {
    const { rowClicks, title, field } = show()
    const onKey = vi.fn()
    window.addEventListener('keydown', onKey)
    await userEvent.dblClick(title())
    rowClicks.mockClear()
    await userEvent.click(field() as HTMLInputElement)
    await userEvent.keyboard('a b')
    expect(rowClicks).not.toHaveBeenCalled()
    expect(onKey).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onKey)
  })

  it('cannot be opened while the song is being separated', async () => {
    const { title, field } = show({ onRename: undefined })
    await userEvent.dblClick(title())
    expect(field()).toBeNull()
  })

  it('a song whose file is gone is renamed the same way', async () => {
    const { onRename, title, field } = show({ source: null })
    await userEvent.dblClick(title())
    expect(field()).toHaveAttribute('placeholder', 'Name')
    await userEvent.keyboard('Dusk{Enter}')
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Dusk')
  })
})

describe('Rename in the row menu', () => {
  const job = (patch: Partial<Job>): Job =>
    ({ id: 'j1', state: 'done', held: false, stems: [{ name: 'vocals', path: 'D:\\out\\Song\\vocals.wav' }], track_path: 'D:\\in\\Song.mp3', track_name: 'Song', ...patch }) as Job
  const on: JobHandlers = { trim: vi.fn(), rename: vi.fn(), reveal: vi.fn(), remove: vi.fn(), cancel: vi.fn() }
  const labels = (j: Job, handlers: JobHandlers = on) => jobMenuItems(j, handlers).map((item) => item.label)

  it('is offered for a song that waits, is done, failed or was cancelled, after Trim', () => {
    expect(labels(job({}))).toEqual(['Trim', 'Rename', 'Show in Explorer', 'Remove from the list'])
    expect(labels(job({ state: 'queued', stems: [] }))).toEqual(['Trim', 'Rename', 'Cancel'])
    for (const state of ['failed', 'cancelled'] as const) expect(labels(job({ state, stems: [] }))).toContain('Rename')
  })

  it('is not offered while the song is being separated, or in a window that cannot rename', () => {
    for (const state of ['preparing', 'running', 'writing'] as const) expect(labels(job({ state, stems: [] }))).not.toContain('Rename')
    expect(labels(job({}), { ...on, rename: undefined })).not.toContain('Rename')
  })

  it('leaves the keyboard in the field it opens: the closing menu does not take the focus back', async () => {
    function Row() {
      const [editing, setEditing] = useState(false)
      const items = jobMenuItems(job({}), { rename: () => setEditing(true), remove: vi.fn() })
      return (
        <TooltipProvider>
          <ul>
            <RowMenu items={items} label="Song actions" render={<li data-testid="row" tabIndex={0} />}>
              <SongName name="Song" source="D:\in\Song.mp3" editing={editing} onEditing={setEditing} onRename={async () => undefined} onError={vi.fn()} hint="" />
            </RowMenu>
          </ul>
        </TooltipProvider>
      )
    }
    render(<Row />)
    fireEvent.contextMenu(screen.getByTestId('row'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const field = await screen.findByLabelText('Song name')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    // Still open, still focused: had the menu handed the focus to the row, the field would
    // have closed as it lost it.
    expect(field).toBeInTheDocument()
    expect(field).toHaveFocus()
  })
})
