import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Link, Model, Recipe, StemFile, SystemInfo } from '@/api/client'
import { DropOverlay } from '@/components/DropOverlay'
import { StemsPanel } from '@/components/StemsPanel'
import { ToastProvider, useToast } from '@/components/toast'
import { CommitInput, ProgressBar, Segmented, TooltipProvider } from '@/components/ui'
import { dragSource } from '@/lib/sourcedrag'
import { SelectionProvider } from '@/state/selection'
import { QueueView } from '@/views/QueueView'
import { bridge } from './setup'

const setAnalysis = { job: { mutateAsync: vi.fn() }, stemSet: { mutateAsync: vi.fn() } }
const actions = {
  startAll: { mutate: vi.fn() },
  start: { mutate: vi.fn() },
  cancel: { mutate: vi.fn() },
  retry: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  reorder: { mutate: vi.fn() },
  clearFinished: { mutate: vi.fn() },
}
let jobs: Job[] = []

let links: Link[] = []
let system: Partial<SystemInfo> | undefined
const linkActions = { add: { mutate: vi.fn() }, retry: { mutate: vi.fn() }, remove: { mutate: vi.fn() } }
const MIX_PATH = 'D:\\out\\Song\\full-song\\Mixes\\Song - no vocals.wav'
const createMix = { mutateAsync: vi.fn(async (_paths: string[]) => ({ path: MIX_PATH })) }
const link = (patch: Partial<Link>): Link => ({
  id: 'l1',
  url: 'https://www.youtube.com/watch?v=abc',
  name: 'youtube.com',
  state: 'resolving',
  progress: 0,
  error: null,
  created_at: 0,
  ...patch,
})

vi.mock('@/api/queries', () => ({
  keys: { jobs: ['jobs'] },
  useJobs: () => ({ data: jobs }),
  useJobActions: () => actions,
  useSetAnalysis: () => setAnalysis,
  useLinks: () => ({ data: links }),
  useLinkActions: () => linkActions,
  useCreateMix: () => createMix,
  useSystem: () => ({ data: system }),
  useSettings: () => ({ data: { output_format: 'wav32f' } }),
  usePatchSettings: () => ({ mutate: vi.fn() }),
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
  held: false,
  created_at: 0,
  started_at: null,
  finished_at: null,
  notes: [],
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
  links = []
  system = undefined
})

describe('QueueView', () => {
  const view = (onSelect = vi.fn(), onAddFiles = vi.fn()) =>
    wrap(
      <QueueView recipes={[]} models={[]} selectedJob={null} onSelect={onSelect} onAddFiles={onAddFiles} onPasteLink={onPasteLink} />,
    )
  const onPasteLink = vi.fn()

  it('has a Paste link button beside Add files', async () => {
    view()
    await userEvent.click(screen.getByRole('button', { name: 'Paste link' }))
    expect(onPasteLink).toHaveBeenCalledTimes(1)
  })

  it('shows a song being fetched from a link after the jobs, and cancels it', async () => {
    jobs = [job({ state: 'running', progress: 0.5 })]
    links = [link({ name: 'Night Drive', state: 'downloading', progress: 0.37 })]
    view()
    expect(screen.getByText('Queue').parentElement).toHaveTextContent('Queue 2')
    const row = screen.getByTestId('link-row')
    expect(row.previousElementSibling).toHaveAttribute('data-testid', 'job-row')
    expect(within(row).getByText('Night Drive')).toBeInTheDocument()
    expect(within(row).getByTestId('link-status')).toHaveTextContent('Fetching from youtube.com')
    expect(within(row).getByText('37%')).toBeInTheDocument()
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37')
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect(linkActions.remove.mutate).toHaveBeenCalledWith('l1', expect.anything())
  })

  it('keeps a fetch that failed, with the reason, to try again or dismiss', async () => {
    links = [link({ state: 'failed', error: 'This link is a playlist of 12 songs. Paste the link to one song.' })]
    view()
    const row = screen.getByTestId('link-row')
    expect(screen.queryByRole('heading', { name: 'Drop audio or video here' })).not.toBeInTheDocument()
    expect(within(row).getByTestId('link-status')).toHaveTextContent('playlist of 12 songs')
    expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Try again' }))
    expect(linkActions.retry.mutate).toHaveBeenCalledWith('l1', expect.anything())
    await userEvent.click(within(row).getByRole('button', { name: 'Dismiss' }))
    expect(linkActions.remove.mutate).toHaveBeenCalledWith('l1', expect.anything())
  })

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

  it('drags the original song by its title, before and after separation', async () => {
    const onSelect = vi.fn()
    jobs = [job({ id: 'q', track_path: 'D:/out/_links/Song.m4a' })]
    view(onSelect)
    const title = screen.getByRole('button', { name: 'Drag the original file of Song' })
    fireEvent.dragStart(title)
    expect(bridge.startDrag).toHaveBeenLastCalledWith(['D:/out/_links/Song.m4a'])
    // A click on the title still opens the job.
    await userEvent.click(title)
    expect(onSelect).toHaveBeenCalled()
  })

  it('shows a song that waits for Start, and starts all of them or one', () => {
    jobs = [job({ id: 'a', held: true }), job({ id: 'b', held: true }), job({ id: 'c' })]
    view()
    const rows = screen.getAllByTestId('job-row')
    expect(within(rows[0]!).getByTestId('job-status')).toHaveTextContent('Ready to start')
    expect(within(rows[2]!).getByTestId('job-status')).toHaveTextContent('Queued, up next')
    fireEvent.click(screen.getByRole('button', { name: 'Start 2 songs' }))
    expect(actions.startAll.mutate).toHaveBeenCalled()
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Start this one' }))
    expect(actions.start.mutate).toHaveBeenCalledWith('b', expect.anything())
    expect(within(rows[2]!).queryByRole('button', { name: 'Start this one' })).not.toBeInTheDocument()
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

  it('shows what did not go as planned in a job, under its status', () => {
    jobs = [job({ id: 'a', state: 'done', notes: ['BS-RoFormer SW ran on the CPU: not enough GPU memory'] }), job({ id: 'b', state: 'done' })]
    view()
    const [first, second] = screen.getAllByTestId('job-row')
    expect(within(first!).getByRole('note')).toHaveTextContent('BS-RoFormer SW ran on the CPU: not enough GPU memory')
    expect(within(first!).getByTestId('job-status')).toHaveTextContent('Done')
    expect(within(second!).queryByRole('note')).not.toBeInTheDocument()
  })

  describe('a recipe and this machine', () => {
    const recipe = (patch: Partial<Recipe>): Recipe =>
      ({
        id: 'full-song',
        name: 'Full song',
        description: '',
        outputs: ['vocals', 'drums'],
        use_case: 'Full song',
        experimental: false,
        missing_models: [],
        download_bytes: 0,
        selectable_outputs: false,
        supports_sum_to_mix: false,
        fit: 'fits',
        fit_model: 'sw',
        memory_gb: 3.8,
        ...patch,
      }) as Recipe
    const leap = { id: 'leap', name: 'BS-RoFormer Leap Xe', bytes: 1, status: 'installed', stems: ['vocals'], fit: 'no', memory_gb: 7.2 } as unknown as Model
    const best = recipe({ id: 'best', name: 'Best vocals', fit: 'no', fit_model: 'leap', memory_gb: 7.2 })
    const bar = (recipes: Recipe[], onAddFiles = vi.fn()) =>
      wrap(<QueueView recipes={recipes} models={[leap]} selectedJob={null} onSelect={vi.fn()} onAddFiles={onAddFiles} onPasteLink={vi.fn()} />)

    beforeEach(() => {
      system = { cuda_available: true, gpu_backend: 'cuda', memory_budget_gb: 6, memory_gb: 6, memory_overridden: false }
    })

    it('shows no mark when the recipe fits', () => {
      bar([recipe({})])
      expect(screen.queryByTestId('recipe-fit')).not.toBeInTheDocument()
    })

    it('marks a tight recipe without a warning colour', () => {
      bar([recipe({ fit: 'tight' })])
      const chip = screen.getByTestId('recipe-fit')
      expect(chip).toHaveTextContent('tight fit')
      expect(chip.className).not.toMatch(/warn|danger/)
    })

    it('marks a recipe that is too large, names the model in the list, and still takes files', async () => {
      localStorage.setItem('openstems.selection.v1', JSON.stringify({ target: 'best' }))
      const onAddFiles = vi.fn()
      bar([best, recipe({})], onAddFiles)
      expect(screen.getByTestId('recipe-fit')).toHaveTextContent('too large for this PC')
      fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['x'], 'a.mp3')] } })
      expect(onAddFiles).toHaveBeenCalledTimes(1)

      await userEvent.click(screen.getByRole('combobox', { name: 'Recipe' }))
      const option = await screen.findByRole('option', { name: /Best vocals/ })
      const mark = within(option).getByTestId('fit-chip')
      expect(mark).toHaveTextContent('too large')
      expect(mark).toHaveAttribute(
        'title',
        'BS-RoFormer Leap Xe needs about 7.2 GB. This PC has about 6.0 GB of VRAM for a model. It may not fit. If it does not, it runs on the CPU, which is much slower.',
      )
      expect(within(await screen.findByRole('option', { name: /Full song/ })).queryByTestId('fit-chip')).not.toBeInTheDocument()
      // The single model is in the list too, with its own mark.
      expect(within(await screen.findByRole('option', { name: /BS-RoFormer Leap Xe/ })).getByTestId('fit-chip')).toHaveTextContent('too large')
    })

    it('starts on a recipe that fits when the default does not', () => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <TooltipProvider>
            <ToastProvider>
              <SelectionProvider settings={{ ...settings, default_recipe: 'best' }} recipes={[best, recipe({})]}>
                <QueueView recipes={[best, recipe({})]} models={[leap]} selectedJob={null} onSelect={vi.fn()} onAddFiles={vi.fn()} onPasteLink={vi.fn()} />
              </SelectionProvider>
            </ToastProvider>
          </TooltipProvider>
        </QueryClientProvider>,
      )
      expect(screen.getByRole('combobox', { name: 'Recipe' })).toHaveTextContent('Full song')
      expect(screen.queryByTestId('recipe-fit')).not.toBeInTheDocument()
    })
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

const onDrop = vi.fn()
function dropFiles(...names: string[]): void {
  const files = names.map((name) => new File(['x'], name))
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } })
  act(() => {
    window.dispatchEvent(event)
  })
}

describe('StemsPanel', () => {
  const stems = ['vocals', 'drums', 'bass'].map(stem)
  const panel = () =>
    wrap(
      <StemsPanel title="Song" subtitle="Full song" directory="D:\\out\\Song\\full-song" stems={stems} analysis={{ bpm: 127.6, key: 'A minor' }} onClose={vi.fn()} />,
    )

  it('says under the title when a model ran on the CPU, and nothing otherwise', () => {
    panel()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    cleanup()
    wrap(<StemsPanel title="Song" subtitle="Full song" directory="D:\\out" stems={stems} notes={['BS-RoFormer SW ran on the CPU: not enough GPU memory']} onClose={vi.fn()} />)
    expect(screen.getByRole('note')).toHaveTextContent('BS-RoFormer SW ran on the CPU: not enough GPU memory')
  })

  it('lists a row and waveform per stem, with tempo and key', () => {
    panel()
    expect(screen.getAllByTestId('stem-row')).toHaveLength(3)
    expect(screen.getAllByTestId('waveform')).toHaveLength(3)
    // In fields, so that a wrong figure can be typed over.
    expect(screen.getByLabelText<HTMLInputElement>('Tempo in BPM').value).toBe('127.6')
    expect(screen.getByLabelText<HTMLInputElement>('Key').value).toBe('A minor')
  })

  it('drags one stem or all of them as real file paths', () => {
    panel()
    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag drums' }))
    expect(bridge.startDrag).toHaveBeenLastCalledWith([stems[1]!.path])
    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag all stems' }))
    expect(bridge.startDrag).toHaveBeenLastCalledWith(stems.map((s) => s.path))
  })

  it('drags the original song by its title, and keeps a plain title without one', () => {
    wrap(<StemsPanel title="Song" source={'C:/in/Song.webm'} subtitle="Full song" directory="D:/out" stems={stems} onClose={vi.fn()} />)
    const title = screen.getByRole('button', { name: 'Drag the original file of Song' })
    expect(title.closest('h2')).toHaveTextContent('Song')
    fireEvent.dragStart(title)
    expect(bridge.startDrag).toHaveBeenLastCalledWith(['C:/in/Song.webm'])
    cleanup()
    panel()
    expect(screen.queryByTestId('drag-source')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Song' })).toBeInTheDocument()
  })

  it('does not queue the original again when its drag is let go over the window', () => {
    render(<DropOverlay onDrop={onDrop} label="Full song" />)
    dragSource({ preventDefault: vi.fn() }, 'C:/in/Song.mp3')
    dropFiles('Song.mp3')
    expect(onDrop).not.toHaveBeenCalled()
    // Once that drag is over, the same file dropped from outside is a song to separate.
    dropFiles('Song.mp3')
    expect(onDrop).toHaveBeenCalledTimes(1)
    dragSource({ preventDefault: vi.fn() }, 'C:/in/Song.mp3')
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { buttons: 0 }))
    })
    dropFiles('Song.mp3')
    expect(onDrop).toHaveBeenCalledTimes(2)
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

describe('StemsPanel: the mix you hear', () => {
  const stems = ['vocals', 'drums', 'bass'].map(stem)
  const panel = () =>
    wrap(<StemsPanel title="Song" subtitle="Full song" directory="D:\\out\\Song\\full-song" stems={stems} onClose={vi.fn()} />)

  it('offers no mix while every stem is audible', () => {
    panel()
    expect(screen.queryByTestId('drag-mix')).not.toBeInTheDocument()
  })

  it('writes what mute leaves audible as one file and drags it', async () => {
    panel()
    await userEvent.click(screen.getByRole('button', { name: 'Mute vocals' }))
    const handle = screen.getByTestId('drag-mix')
    expect(handle).toHaveTextContent('Preparing')
    expect(handle).toHaveAttribute('aria-disabled', 'true')
    await waitFor(() => expect(createMix.mutateAsync).toHaveBeenCalledWith([stems[1]!.path, stems[2]!.path]))
    await waitFor(() => expect(screen.getByTestId('drag-mix')).toHaveTextContent('Drag mix'))
    expect(screen.getByTestId('drag-mix')).toHaveAccessibleName('Drag the mix: No vocals')
    fireEvent.dragStart(screen.getByTestId('drag-mix'))
    expect(window.openstems.startDrag).toHaveBeenCalledWith([MIX_PATH])
  })

  it('drags the stem itself when solo leaves one', async () => {
    panel()
    await userEvent.click(screen.getByRole('button', { name: 'Solo bass' }))
    fireEvent.dragStart(screen.getByTestId('drag-mix'))
    expect(window.openstems.startDrag).toHaveBeenCalledWith([stems[2]!.path])
    expect(createMix.mutateAsync).not.toHaveBeenCalled()
  })
})

describe('StemsPanel: a set with groups', () => {
  const stems = [
    { ...stem('lead vocals'), group: 'vocals' },
    { ...stem('backing vocals'), group: 'vocals' },
    { ...stem('kick'), group: 'drums' },
    { ...stem('snare'), group: 'drums' },
    { ...stem('other drums'), group: 'drums' },
    stem('bass'),
  ]
  const panel = () =>
    wrap(<StemsPanel title="Song" subtitle="Every stem" directory="D:\\out\\Song\\every-stem" stems={stems} onClose={vi.fn()} />)

  it('puts a heading over the parts of each group and none over a stem on its own', () => {
    panel()
    expect(screen.getAllByTestId('stem-row')).toHaveLength(6)
    const headings = screen.getAllByTestId('stem-group')
    expect(headings.map((h) => h.getAttribute('data-group'))).toEqual(['vocals', 'drums'])
    expect(headings[1]).toHaveTextContent('Drums')
    expect(headings[1]).toHaveTextContent('3 parts')
    // Under its heading a part goes by its short name; its full name stays for a screen reader.
    const row = screen.getByRole('button', { name: 'Drag other drums' })
    expect(row).toHaveTextContent(/^other$/)
  })

  it('solos and mutes every part of a group from its heading', async () => {
    panel()
    await userEvent.click(screen.getByRole('button', { name: 'Solo drums' }))
    for (const name of ['kick', 'snare', 'other drums']) {
      expect(screen.getByRole('button', { name: `Solo ${name}` })).toHaveAttribute('aria-pressed', 'true')
    }
    expect(screen.getByRole('button', { name: 'Solo bass' })).toHaveAttribute('aria-pressed', 'false')
    // What is heard is the whole kit, and the mix says so.
    expect(screen.getByTestId('drag-mix')).toHaveAccessibleName('Drag the mix: Drums')
    await userEvent.click(screen.getByRole('button', { name: 'Solo drums' }))
    expect(screen.getByRole('button', { name: 'Solo kick' })).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(screen.getByRole('button', { name: 'Mute vocals' }))
    expect(screen.getByRole('button', { name: 'Mute lead vocals' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Mute vocals' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('writes a group as one file when the pointer comes near, then drags it', async () => {
    panel()
    const handle = screen.getByRole('button', { name: 'Drag the drums as one file' })
    // Nothing is written for a group nobody reached for, and a drag before the file exists does nothing.
    expect(createMix.mutateAsync).not.toHaveBeenCalled()
    fireEvent.dragStart(handle)
    expect(window.openstems.startDrag).not.toHaveBeenCalled()
    fireEvent.pointerEnter(handle)
    await waitFor(() => expect(createMix.mutateAsync).toHaveBeenCalledWith([stems[2]!.path, stems[3]!.path, stems[4]!.path]))
    await waitFor(() => expect(handle).toHaveAttribute('data-path', MIX_PATH))
    fireEvent.dragStart(handle)
    expect(window.openstems.startDrag).toHaveBeenCalledWith([MIX_PATH])
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
