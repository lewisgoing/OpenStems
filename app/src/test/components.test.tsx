import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Link, Model, Recipe, StemFile, SystemInfo } from '@/api/client'
import { DropOverlay } from '@/components/DropOverlay'
import { StemsPanel } from '@/components/StemsPanel'
import { ToastProvider, useToast } from '@/components/toast'
import { CommitInput, ProgressBar, Segmented, TooltipProvider } from '@/components/ui'
import { dragAllHint, splitEmpty, stemCount } from '@/lib/empty'
import { dragSource } from '@/lib/sourcedrag'
import { SelectionProvider } from '@/state/selection'
import { SORT_KEY, loadSort, matchesSearch, searchTerms, sortQueue } from '@/lib/queuesort'
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
  useSettings: () => ({ data: engineSettings }),
  usePatchSettings: () => ({ mutate: vi.fn() }),
}))
vi.mock('@/api/engine', () => ({
  useEngine: () => ({ api: {}, connection: { baseUrl: 'http://127.0.0.1:1', token: 't' } }),
}))
vi.mock('@/components/Waveform', () => ({
  Waveform: ({ label }: { label: string }) => <div data-testid="waveform">{label}</div>,
  useSharedGain: () => 1,
}))

/** What the engine's settings are read as. A test may add to it and must take it back. */
const engineSettings: Record<string, unknown> = { output_format: 'wav32f' }

const stem = (name: string): StemFile => ({
  name,
  empty: false,
  file: `Song - ${name}.wav`,
  path: `D:\\out\\Song\\full-song\\Song - ${name}.wav`,
  peaks: `D:\\out\\Song\\full-song\\.peaks\\${name}.json`,
  samples: 88200,
  sample_rate: 44100,
  start: 0,
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
  // These are about the rows, not their order: the list is pinned to the order songs run in.
  beforeEach(() => localStorage.setItem(SORT_KEY, 'run'))
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

describe('the order and search of the queue, as plain functions', () => {
  const rows = [
    { name: 'beta 10', created_at: 1 },
    { name: 'Alpha', created_at: 3 },
    { name: 'beta 9', created_at: 2 },
  ]
  const names = (sort: Parameters<typeof sortQueue>[1]) => sortQueue(rows, sort).map((row) => row.name)

  it('puts the newest first, the oldest first, by name, or leaves the order songs run in', () => {
    expect(names('newest')).toEqual(['Alpha', 'beta 9', 'beta 10'])
    expect(names('oldest')).toEqual(['beta 10', 'beta 9', 'Alpha'])
    // Case does not count, and 9 comes before 10.
    expect(names('name')).toEqual(['Alpha', 'beta 9', 'beta 10'])
    expect(names('run')).toEqual(['beta 10', 'Alpha', 'beta 9'])
    expect(rows.map((row) => row.name)).toEqual(['beta 10', 'Alpha', 'beta 9'])
  })

  it('counts the later of two songs added in the same instant as the newer', () => {
    const same = [
      { name: 'a', created_at: 5 },
      { name: 'b', created_at: 5 },
    ]
    expect(sortQueue(same, 'newest').map((row) => row.name)).toEqual(['b', 'a'])
    expect(sortQueue(same, 'oldest').map((row) => row.name)).toEqual(['a', 'b'])
  })

  it('finds every word of a search, in any order, whatever the case or the accents', () => {
    expect(matchesSearch(searchTerms(''), 'Song')).toBe(true)
    expect(matchesSearch(searchTerms('  '), 'Song')).toBe(true)
    expect(matchesSearch(searchTerms('drive NIGHT'), 'Night Drive', 'Full song')).toBe(true)
    expect(matchesSearch(searchTerms('night full'), 'Night Drive', 'Full song')).toBe(true)
    expect(matchesSearch(searchTerms('night vocals'), 'Night Drive', 'Full song')).toBe(false)
    expect(matchesSearch(searchTerms('beyonce'), 'Beyoncé - Halo')).toBe(true)
    expect(matchesSearch(searchTerms('x'), null, undefined)).toBe(false)
  })

  it('starts on the newest first and keeps a pick, ignoring one it does not know', () => {
    expect(loadSort()).toBe('newest')
    localStorage.setItem(SORT_KEY, 'name')
    expect(loadSort()).toBe('name')
    localStorage.setItem(SORT_KEY, 'sideways')
    expect(loadSort()).toBe('newest')
  })
})

describe('QueueView: order and search', () => {
  const view = () =>
    wrap(<QueueView recipes={[]} models={[]} selectedJob={null} onSelect={vi.fn()} onAddFiles={vi.fn()} onPasteLink={vi.fn()} />)
  const titles = () => screen.getAllByTestId(/^(job|link)-row$/).map((row) => row.querySelector('.font-medium')?.textContent)
  const three = () => [
    job({ id: 'a', track_name: 'Cello', created_at: 10, state: 'done' }),
    job({ id: 'b', track_name: 'Bells', created_at: 20, queue_position: 0 }),
    job({ id: 'c', track_name: 'Anthem', created_at: 30, queue_position: 1, recipe_name: 'Drum kit' }),
  ]
  const pick = async (name: string) => {
    await userEvent.click(screen.getByRole('combobox', { name: 'Sort the queue' }))
    await userEvent.click(await screen.findByRole('option', { name: new RegExp(`^${name}`) }))
  }

  it('shows the newest song first unless another order is picked, and remembers the pick', async () => {
    jobs = three()
    links = [link({ name: 'Night Drive', state: 'downloading', created_at: 40 })]
    const first = view()
    // The song still being fetched was added last, so it leads.
    expect(titles()).toEqual(['Night Drive', 'Anthem', 'Bells', 'Cello'])
    expect(screen.getByRole('combobox', { name: 'Sort the queue' })).toHaveTextContent('Newest')

    await pick('Oldest')
    expect(titles()).toEqual(['Cello', 'Bells', 'Anthem', 'Night Drive'])
    await pick('Name')
    expect(titles()).toEqual(['Anthem', 'Bells', 'Cello', 'Night Drive'])
    expect(localStorage.getItem(SORT_KEY)).toBe('name')

    first.unmount()
    view()
    expect(titles()).toEqual(['Anthem', 'Bells', 'Cello', 'Night Drive'])
  })

  it('lets a waiting song be dragged only in the order songs run in', async () => {
    jobs = three()
    view()
    expect(screen.queryByRole('button', { name: 'Reorder Bells' })).not.toBeInTheDocument()
    await pick('Run order')
    expect(titles()).toEqual(['Cello', 'Bells', 'Anthem'])
    expect(screen.getByRole('button', { name: 'Reorder Bells' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reorder Anthem' })).toBeInTheDocument()
    // The menu's moves are about the order songs run in, and stay in every order.
    await pick('Newest')
    fireEvent.contextMenu(screen.getAllByTestId('job-row')[0]!)
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to the top' }))
    expect(actions.reorder.mutate).toHaveBeenCalledWith(['c', 'b'], expect.anything())
  })

  it('narrows the list to what the search finds, by song or recipe, and says how many', async () => {
    jobs = three()
    links = [link({ name: 'Night Drive', state: 'downloading', created_at: 40 })]
    view()
    const search = screen.getByRole('textbox', { name: 'Search the queue' })
    expect(screen.getByTestId('queue-count')).toHaveTextContent(/^4$/)

    await userEvent.type(search, 'LL')
    expect(titles()).toEqual(['Bells', 'Cello'])
    expect(screen.getByTestId('queue-count')).toHaveTextContent('2 of 4')

    await userEvent.clear(search)
    await userEvent.type(search, 'drum kit')
    expect(titles()).toEqual(['Anthem'])

    // A song being fetched is found by its name or its address.
    await userEvent.clear(search)
    await userEvent.type(search, 'youtube')
    expect(titles()).toEqual(['Night Drive'])

    await userEvent.click(screen.getByRole('button', { name: 'Clear the search' }))
    expect(search).toHaveValue('')
    expect(search).toHaveFocus()
    expect(titles()).toHaveLength(4)
  })

  it('says when nothing matches, and Escape empties the search and then leaves it', async () => {
    jobs = three()
    view()
    const search = screen.getByRole('textbox', { name: 'Search the queue' })
    await userEvent.type(search, 'zzz')
    expect(screen.getByTestId('queue-no-match')).toHaveTextContent('Nothing in the queue matches "zzz".')
    expect(screen.queryByTestId('job-row')).not.toBeInTheDocument()
    // The queue is not empty: the drop hint stays away and Start and Clear stay.
    expect(screen.queryByRole('heading', { name: 'Drop audio or video here' })).not.toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(search).toHaveValue('')
    expect(search).toHaveFocus()
    expect(screen.getAllByTestId('job-row')).toHaveLength(3)
    await userEvent.keyboard('{Escape}')
    expect(search).not.toHaveFocus()
  })

  it('goes to the search on Ctrl+F, not while the trimmer covers the queue', () => {
    jobs = three()
    const shown = view()
    const search = screen.getByRole('textbox', { name: 'Search the queue' })
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(search).toHaveFocus()
    search.blur()
    shown.unmount()

    wrap(<QueueView recipes={[]} models={[]} selectedJob={null} onSelect={vi.fn()} onAddFiles={vi.fn()} onPasteLink={vi.fn()} covered />)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('textbox', { name: 'Search the queue' })).not.toHaveFocus()
  })

  it('brings a new song in, and not one that a search brings back', async () => {
    jobs = three()
    view()
    const search = screen.getByRole('textbox', { name: 'Search the queue' })
    expect(screen.getAllByTestId('job-row')[0]).toHaveClass('row-enter')
    await userEvent.type(search, 'anthem')
    await userEvent.clear(search)
    const rows = screen.getAllByTestId('job-row')
    expect(rows).toHaveLength(3)
    // Anthem never left; the two the search hid are back without the entrance.
    expect(rows[0]).toHaveClass('row-enter')
    expect(rows[1]).not.toHaveClass('row-enter')
    expect(rows[2]).not.toHaveClass('row-enter')
  })
})

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

describe('empty stems, as plain functions', () => {
  const of = (...empty: boolean[]) => empty.map((value, index) => ({ name: `s${index}`, empty: value }))

  it('leaves the empty ones out while hiding is on, in the stems own order', () => {
    const stems = of(false, true, false, true)
    expect(splitEmpty(stems, true)).toEqual({ shown: [stems[0], stems[2]], hidden: [stems[1], stems[3]] })
    // Off, and with nothing empty, the list is the very same one: nothing re-renders for it.
    expect(splitEmpty(stems, false).shown).toBe(stems)
    expect(splitEmpty(of(false, false), true).shown).toHaveLength(2)
    expect(splitEmpty<{ name: string; empty?: boolean }>([{ name: 'old' }], true)).toEqual({ shown: [{ name: 'old' }], hidden: [] })
  })

  it('shows every stem of a song that has nothing in any', () => {
    const silent = of(true, true)
    expect(splitEmpty(silent, true)).toEqual({ shown: silent, hidden: [] })
    expect(splitEmpty([], true)).toEqual({ shown: [], hidden: [] })
  })

  it('counts stems and says what a drag carries', () => {
    expect([0, 1, 2, 13].map(stemCount)).toEqual(['0 stems', '1 stem', '2 stems', '13 stems'])
    expect(dragAllHint(6, 0)).toBe('Drag every stem into your DAW or a folder')
    expect(dragAllHint(1, 5)).toBe('Drag the one stem with sound into your DAW or a folder. 5 empty ones stay behind')
    expect(dragAllHint(5, 1)).toBe('Drag the 5 stems with sound into your DAW or a folder. 1 empty one stays behind')
  })
})

describe('StemsPanel: empty stems', () => {
  // A rap song through the six-stem recipe: only the vocals and the drums hold anything.
  const stems = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'].map((name) => ({
    ...stem(name),
    empty: !['vocals', 'drums'].includes(name),
  }))
  const onTrim = vi.fn()
  const panel = (hideEmpty: boolean) =>
    wrap(<StemsPanel title="Song" subtitle="Full song" directory="D:\out\Song\full-song" stems={stems} hideEmpty={hideEmpty} onTrim={onTrim} onClose={vi.fn()} />)
  const names = () => screen.getAllByTestId('waveform').map((el) => el.textContent)

  it('lists only the stems with sound, and names the rest in one line', () => {
    panel(true)
    expect(names()).toEqual(['vocals', 'drums'])
    const line = screen.getByTestId('empty-stems')
    expect(line).toHaveTextContent('4 empty: bass, guitar, piano, other')
    expect(within(line).getByRole('button', { name: 'Show empty stems' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('drags, mixes and trims what is shown', async () => {
    panel(true)
    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag all stems' }))
    expect(bridge.startDrag).toHaveBeenLastCalledWith([stems[0]!.path, stems[1]!.path])
    // Trim opens on the two with sound, not on six.
    await userEvent.click(screen.getByTestId('panel-trim'))
    expect(onTrim).toHaveBeenLastCalledWith(['vocals', 'drums'], expect.anything())
    // Of two stems, one muted leaves the other: its own file, and no mix to write.
    await userEvent.click(screen.getByRole('button', { name: 'Mute vocals' }))
    fireEvent.dragStart(screen.getByTestId('drag-mix'))
    expect(bridge.startDrag).toHaveBeenLastCalledWith([stems[1]!.path])
    expect(createMix.mutateAsync).not.toHaveBeenCalled()
  })

  it('brings the empty stems back where they belong, marked, and puts them away again', async () => {
    panel(true)
    await userEvent.click(screen.getByRole('button', { name: 'Show empty stems' }))
    expect(names()).toEqual(['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'])
    const rows = screen.getAllByTestId('stem-row')
    expect(rows.map((row) => row.hasAttribute('data-empty'))).toEqual([false, false, true, true, true, true])
    expect(screen.getByTestId('empty-stems')).toHaveTextContent('4 empty shown: bass, guitar, piano, other')
    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag all stems' }))
    expect(bridge.startDrag.mock.calls.at(-1)?.[0]).toHaveLength(6)
    await userEvent.click(screen.getByTestId('panel-trim'))
    expect(onTrim).toHaveBeenLastCalledWith(null, expect.anything())
    await userEvent.click(screen.getByRole('button', { name: 'Hide empty stems' }))
    expect(names()).toEqual(['vocals', 'drums'])
  })

  it('shows every stem with the setting off, and has no line about it', () => {
    panel(false)
    expect(names()).toHaveLength(6)
    expect(screen.queryByTestId('empty-stems')).not.toBeInTheDocument()
    // Still told apart: an empty stem's name steps back.
    expect(screen.getAllByTestId('stem-row')[3]).toHaveAttribute('data-empty')
  })

  it('has nothing to hide in a song whose stems all hold something', () => {
    wrap(<StemsPanel title="Song" subtitle="Full song" directory="D:\out" stems={['vocals', 'drums'].map(stem)} hideEmpty onClose={vi.fn()} />)
    expect(names()).toEqual(['vocals', 'drums'])
    expect(screen.queryByTestId('empty-stems')).not.toBeInTheDocument()
  })
})

describe('QueueView: empty stems', () => {
  beforeEach(() => localStorage.setItem(SORT_KEY, 'run'))
  afterEach(() => {
    delete engineSettings.hide_empty_stems
  })
  const stems = ['vocals', 'drums', 'bass'].map((name) => ({ ...stem(name), empty: name !== 'vocals' }))
  const view = () =>
    wrap(<QueueView recipes={[]} models={[]} selectedJob={null} onSelect={vi.fn()} onAddFiles={vi.fn()} onPasteLink={vi.fn()} />)

  it('counts and drags the stems with sound while hiding is on', () => {
    jobs = [job({ state: 'done', progress: 1, stems })]
    engineSettings.hide_empty_stems = true
    view()
    const handle = screen.getByRole('button', { name: 'Drag all stems of Song' })
    expect(handle).toHaveTextContent('1 stem')
    expect(handle).not.toHaveTextContent('stems')
    fireEvent.dragStart(handle)
    expect(bridge.startDrag).toHaveBeenLastCalledWith([stems[0]!.path])
  })

  it('counts and drags them all with it off', () => {
    jobs = [job({ state: 'done', progress: 1, stems })]
    view()
    const handle = screen.getByRole('button', { name: 'Drag all stems of Song' })
    expect(handle).toHaveTextContent('3 stems')
    fireEvent.dragStart(handle)
    expect(bridge.startDrag.mock.calls.at(-1)?.[0]).toHaveLength(3)
  })
})
