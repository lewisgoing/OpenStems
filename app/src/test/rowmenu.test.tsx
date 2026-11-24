import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/api/client'
import { type JobHandlers, RowMenu, jobMenuItems, linkMenuItems, revealHandlers } from '@/components/RowMenu'
import { moveQueued } from '@/views/QueueView'
import { bridge } from './setup'

/* What a right-click on a row of the queue offers, in both windows. */

const job = (patch: Partial<Job>): Job =>
  ({
    id: 'j1',
    state: 'done',
    held: false,
    stems: [{ name: 'vocals', path: 'D:\\out\\Song\\vocals.wav' }],
    track_path: 'D:\\in\\Song.mp3',
    track_name: 'Song',
    ...patch,
  }) as Job

const all = {
  start: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  showStems: vi.fn(),
  reveal: vi.fn(),
  revealSource: vi.fn(),
  moveTop: vi.fn(),
  moveBottom: vi.fn(),
  remove: vi.fn(),
}
const labels = (j: Job, on: JobHandlers = all) => jobMenuItems(j, on).map((item) => (item.separated ? `— ${item.label}` : item.label))

afterEach(() => {
  bridge.info.platform = 'win32'
  vi.clearAllMocks()
})

describe('the items for each state', () => {
  it('a finished song: its stems, where they are, the original, and taking it off the list', () => {
    expect(labels(job({}))).toEqual(['Show stems', 'Show in Explorer', 'Show the original in Explorer', '— Remove from the list'])
  })

  it('a song waiting its turn: start it, move it, cancel it, and nothing about stems it does not have', () => {
    expect(labels(job({ state: 'queued', held: true, stems: [] }))).toEqual([
      'Start now',
      'Show the original in Explorer',
      '— Move to the top',
      'Move to the bottom',
      '— Cancel',
    ])
  })

  it('a running song can only be cancelled, never removed or moved', () => {
    expect(labels(job({ state: 'running', stems: [] }))).toEqual(['Show the original in Explorer', '— Cancel'])
  })

  it('a failed or cancelled song can be retried, then removed', () => {
    for (const state of ['failed', 'cancelled'] as const) {
      expect(labels(job({ state, stems: [] }))).toEqual(['Show the original in Explorer', '— Retry', '— Remove from the list'])
    }
  })

  it('offers only what the window can do, and draws no line above the first item', () => {
    // The quick-drop window has no reordering.
    const tray = { ...all, moveTop: undefined, moveBottom: undefined }
    expect(labels(job({ state: 'queued', held: false, stems: [], track_path: '' }), tray)).toEqual(['Cancel'])
  })

  it('says Finder on a Mac', () => {
    bridge.info.platform = 'darwin'
    expect(labels(job({}))).toContain('Show in Finder')
    expect(labels(job({}))).toContain('Show the original in Finder')
  })

  it('a link being fetched has its two buttons and no more', () => {
    const on = { retry: vi.fn(), remove: vi.fn() }
    expect(linkMenuItems({ state: 'downloading' }, on).map((i) => i.label)).toEqual(['Cancel'])
    expect(linkMenuItems({ state: 'failed' }, on).map((i) => i.label)).toEqual(['Try again', 'Dismiss'])
  })
})

describe('moving a queued song', () => {
  it('to the top or the bottom, clamped, and not at all when it is not queued', () => {
    expect(moveQueued(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveQueued(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(moveQueued(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a'])
    expect(moveQueued(['a', 'b'], 'x', 0)).toEqual(['a', 'b'])
  })
})

describe('the menu on a row', () => {
  const row = (onRemove = vi.fn()) =>
    render(
      <ul>
        <RowMenu items={jobMenuItems(job({}), { remove: onRemove })} label="Song actions" render={<li data-testid="row" />}>
          Song <input aria-label="Tempo" />
        </RowMenu>
      </ul>,
    )

  it('opens on a right-click, keeps the row element, and runs the item', async () => {
    const onRemove = vi.fn()
    row(onRemove)
    expect(screen.getByTestId('row').tagName).toBe('LI')
    fireEvent.contextMenu(screen.getByTestId('row'))
    const item = await screen.findByRole('menuitem', { name: 'Remove from the list' })
    fireEvent.click(item)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('leaves a right-click in a text field to the field', async () => {
    row()
    fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Tempo' }))
    await act(async () => undefined)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('showing files', () => {
  it('shows the first stem in its folder, and says so when the original has gone', async () => {
    const missing = vi.fn()
    const on = revealHandlers(job({}), missing)
    on.reveal?.()
    expect(bridge.revealInExplorer).toHaveBeenCalledWith('D:\\out\\Song\\vocals.wav')
    bridge.revealInExplorer.mockResolvedValueOnce(false)
    await act(async () => on.revealSource?.())
    expect(missing).toHaveBeenCalledWith('The original file is no longer where it was')
  })
})
