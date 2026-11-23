import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, StemFile } from '@/api/client'
import { StemsPanel } from '@/components/StemsPanel'
import { ToastProvider, useToast } from '@/components/toast'
import { CommitInput, ProgressBar, Segmented, TooltipProvider } from '@/components/ui'
import { SelectionProvider } from '@/state/selection'
import { QueueView } from '@/views/QueueView'
import { bridge } from './setup'

const actions = {
  cancel: { mutate: vi.fn() },
  retry: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  reorder: { mutate: vi.fn() },
  clearFinished: { mutate: vi.fn() },
}
let jobs: Job[] = []

vi.mock('@/api/queries', () => ({
  keys: { jobs: ['jobs'] },
  useJobs: () => ({ data: jobs }),
  useJobActions: () => actions,
}))
vi.mock('@/api/engine', () => ({
  useEngine: () => ({ api: {}, connection: { baseUrl: 'http://127.0.0.1:1', token: 't' } }),
}))
vi.mock('@/components/Waveform', () => ({
  Waveform: ({ label }: { label: string }) => <div data-testid="waveform">{label}</div>,
  useSharedGain: () => 1,
}))

const stem = (name: string): StemFile => ({
  name,
  file: `Song - ${name}.wav`,
  path: `D:\\out\\Song\\full-song\\Song - ${name}.wav`,
  peaks: `D:\\out\\Song\\full-song\\.peaks\\${name}.json`,
  samples: 88200,
  sample_rate: 44100,
})

const job = (patch: Partial<Job>): Job => ({
  id: 'j1',
  track_path: 'C:\\in\\Song.mp3',
  track_name: 'Song',
  recipe_id: 'full-song',
  recipe_name: 'Full song',
  quality: 'balanced',
  state: 'queued',
  progress: 0,
  message: '',
  error: null,
  cached: false,
  output_dir: null,
  options: {},
  stems: [],
  analysis: {},
  queue_position: 0,
  created_at: 0,
  started_at: null,
  finished_at: null,
  ...patch,
})

const settings = {
  default_recipe: 'full-song',
  default_quality: 'balanced',
  sum_to_mix: false,
} as Parameters<typeof SelectionProvider>[0]['settings']

function wrap(children: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ToastProvider>
          <SelectionProvider settings={settings}>{children}</SelectionProvider>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  jobs = []
})

describe('QueueView', () => {
  const view = (onSelect = vi.fn(), onAddFiles = vi.fn()) =>
    wrap(<QueueView recipes={[]} models={[]} selectedJob={null} onSelect={onSelect} onAddFiles={onAddFiles} />)

  it('shows the drop hint when the queue is empty', () => {
    view()
    expect(screen.getByRole('heading', { name: 'Drop audio or video here' })).toBeInTheDocument()
  })

  it('shows progress and a cancel button for a running job', async () => {
    jobs = [job({ state: 'running', progress: 0.42, message: 'BS-RoFormer SW' })]
    view()
    const row = screen.getByTestId('job-row')
    expect(within(row).getByText('42%')).toBeInTheDocument()
    expect(within(row).getByTestId('job-status')).toHaveTextContent('BS-RoFormer SW')
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect(actions.cancel.mutate).toHaveBeenCalledWith('j1', expect.anything())
  })

  it('shows the error and a retry button for a failed job', async () => {
    jobs = [job({ state: 'failed', error: 'cannot decode Song.mp3' })]
    view()
    expect(screen.getByTestId('job-status')).toHaveTextContent('cannot decode Song.mp3')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(actions.retry.mutate).toHaveBeenCalledWith('j1', expect.anything())
  })

  it('drags every stem of a finished job and opens it on click', async () => {
    const stems = ['vocals', 'drums', 'bass'].map(stem)
    const done = job({ state: 'done', progress: 1, stems, output_dir: 'D:\\out\\Song\\full-song' })
    jobs = [done]
    const onSelect = vi.fn()
    view(onSelect)
    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag all stems of Song' }))
    expect(bridge.startDrag).toHaveBeenCalledWith(stems.map((s) => s.path))
    await userEvent.click(screen.getByTestId('job-row'))
    expect(onSelect).toHaveBeenCalledWith(done)
  })

  it('says when a result came from the cache and where a job is in the queue', () => {
    jobs = [
      job({ id: 'a', state: 'done', cached: true }),
      job({ id: 'b', state: 'queued', queue_position: 0 }),
      job({ id: 'c', state: 'queued', queue_position: 1 }),
    ]
    view()
    const [first, second, third] = screen.getAllByTestId('job-status')
    expect(first).toHaveTextContent('Done, from the cache')
    expect(second).toHaveTextContent('Queued, up next')
    expect(third).toHaveTextContent('Queued, 1 ahead')
  })

  it('reorders queued jobs by dragging one onto another', () => {
    jobs = [job({ id: 'a' }), job({ id: 'b', track_name: 'Second' }), job({ id: 'c', track_name: 'Third' })]
    view()
    const rows = screen.getAllByTestId('job-row')
    const dataTransfer = { types: ['application/x-openstems-job'], setData: vi.fn(), effectAllowed: '' }
    fireEvent.dragStart(screen.getByRole('button', { name: 'Reorder Third' }), { dataTransfer })
    fireEvent.dragOver(rows[0]!, { dataTransfer })
    fireEvent.drop(rows[0]!, { dataTransfer })
    expect(actions.reorder.mutate).toHaveBeenCalledWith(['c', 'a', 'b'], expect.anything())
  })
})

describe('StemsPanel', () => {
  const stems = ['vocals', 'drums', 'bass'].map(stem)
  const panel = () =>
    wrap(
      <StemsPanel title="Song" subtitle="Full song" directory="D:\\out\\Song\\full-song" stems={stems} analysis={{ bpm: 127.6, key: 'A minor' }} onClose={vi.fn()} />,
    )

  it('lists a row and waveform per stem, with tempo and key', () => {
    panel()
    expect(screen.getAllByTestId('stem-row')).toHaveLength(3)
    expect(screen.getAllByTestId('waveform')).toHaveLength(3)
    expect(screen.getByText('128 BPM')).toBeInTheDocument()
    expect(screen.getByText('A minor')).toBeInTheDocument()
  })

  it('drags one stem or all of them as real file paths', () => {
    panel()
    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag drums' }))
    expect(bridge.startDrag).toHaveBeenLastCalledWith([stems[1]!.path])
    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag all stems' }))
    expect(bridge.startDrag).toHaveBeenLastCalledWith(stems.map((s) => s.path))
  })

  it('toggles solo and mute per stem', async () => {
    panel()
    const solo = screen.getByRole('button', { name: 'Solo vocals' })
    const mute = screen.getByRole('button', { name: 'Mute drums' })
    expect(solo).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(solo)
    await userEvent.click(mute)
    expect(solo).toHaveAttribute('aria-pressed', 'true')
    expect(mute).toHaveAttribute('aria-pressed', 'true')
    // Soloing another stem replaces the first solo.
    await userEvent.click(screen.getByRole('button', { name: 'Solo bass' }))
    expect(solo).toHaveAttribute('aria-pressed', 'false')
  })

  it('reveals the folder in Explorer', async () => {
    panel()
    await userEvent.click(screen.getByRole('button', { name: 'Reveal in Explorer' }))
    expect(bridge.revealInExplorer).toHaveBeenCalledWith(stems[0]!.path)
  })
})

describe('Segmented', () => {
  const options = [
    { value: 'fast', label: 'Fast' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'best', label: 'Best' },
  ]

  it('animates the thumb for a pointer change but not for the keyboard', async () => {
    const onChange = vi.fn()
    render(<Segmented label="Quality" value="balanced" options={options} onChange={onChange} />)
    const group = screen.getByRole('radiogroup', { name: 'Quality' })
    expect(group).toHaveAttribute('data-animate', 'false')

    await userEvent.click(screen.getByRole('radio', { name: 'Best' }))
    expect(onChange).toHaveBeenLastCalledWith('best')
    expect(group).toHaveAttribute('data-animate', 'true')

    // Keyboard-initiated changes are never animated.
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Balanced' }), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('fast')
    expect(group).toHaveAttribute('data-animate', 'false')
  })
})

describe('CommitInput', () => {
  it('commits on Enter or blur, not on every key, and Escape reverts', async () => {
    const onCommit = vi.fn()
    render(<CommitInput aria-label="Template" value="{track} - {stem}" onCommit={onCommit} />)
    const input = screen.getByRole('textbox', { name: 'Template' })
    await userEvent.clear(input)
    await userEvent.type(input, '{{stem}')
    expect(onCommit).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('{stem}')

    await userEvent.type(input, ' extra')
    await userEvent.keyboard('{Escape}')
    expect(input).toHaveValue('{track} - {stem}')
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('ProgressBar', () => {
  it('snaps instead of sliding backwards when the value drops', () => {
    const { rerender } = render(<ProgressBar value={0.2} />)
    const fill = () => screen.getByRole('progressbar').firstElementChild as HTMLElement
    expect(fill()).toHaveAttribute('data-reset', 'false')
    rerender(<ProgressBar value={0.8} />)
    expect(fill()).toHaveAttribute('data-reset', 'false')
    rerender(<ProgressBar value={0} />) // a retried job
    expect(fill()).toHaveAttribute('data-reset', 'true')
    rerender(<ProgressBar value={0.1} />)
    expect(fill()).toHaveAttribute('data-reset', 'false')
  })
})

describe('toasts', () => {
  function Trigger() {
    const toast = useToast()
    return <button onClick={() => toast.show('Saved')}>show</button>
  }

  it('pause while hovered and leave after the time that was left', () => {
    vi.useFakeTimers()
    try {
      render(
        <ToastProvider>
          <Trigger />
        </ToastProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'show' }))
      const toast = screen.getByRole('status')

      act(() => vi.advanceTimersByTime(4000))
      fireEvent.pointerEnter(toast)
      expect(toast).toHaveAttribute('data-paused', 'true')
      act(() => vi.advanceTimersByTime(60_000)) // far past the five seconds: still there
      expect(screen.getByRole('status')).toBeInTheDocument()

      fireEvent.pointerLeave(toast)
      act(() => vi.advanceTimersByTime(900)) // one second was left
      expect(screen.getByRole('status')).not.toHaveAttribute('data-leaving')
      act(() => vi.advanceTimersByTime(200))
      expect(screen.getByRole('status')).toHaveAttribute('data-leaving', 'true')
      act(() => vi.advanceTimersByTime(200))
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
