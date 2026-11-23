import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFS,
  type Rect,
  isTrayActivity,
  parsePrefs,
  popupPlacement,
  taskbarEdge,
  trayPresentation,
} from '../../electron/traylogic'
import type { Job, Model, Recipe, StemFile } from '@/api/client'
import { ToastProvider } from '@/components/toast'
import { TooltipProvider } from '@/components/ui'
import { SelectionProvider } from '@/state/selection'
import TrayApp, { QuickDrop, activityOf } from '@/tray/TrayApp'
import { TraySettings } from '@/views/SettingsView'
import { bridge } from './setup'

const createJobs = { mutate: vi.fn() }
const actions = {
  cancel: { mutate: vi.fn() },
  retry: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  reorder: { mutate: vi.fn() },
  clearFinished: { mutate: vi.fn() },
}
const modelActions = { pull: { mutate: vi.fn() }, cancel: { mutate: vi.fn() } }
let jobs: Job[] | undefined = []
let recipes: Recipe[] = []
let models: Model[] = []

const settings = {
  default_recipe: 'full-song',
  default_quality: 'balanced',
  sum_to_mix: false,
} as Parameters<typeof SelectionProvider>[0]['settings']

vi.mock('@/api/queries', () => ({
  keys: { jobs: ['jobs'] },
  useJobs: () => ({ data: jobs }),
  useJobActions: () => actions,
  useCreateJobs: () => createJobs,
  useModelActions: () => modelActions,
  useSettings: () => ({ data: settings }),
  useRecipes: () => ({ data: recipes }),
  useModels: () => ({ data: { models } }),
}))
vi.mock('@/api/engine', () => ({
  useEngine: () => ({ api: {}, connection: { baseUrl: 'http://127.0.0.1:1', token: 't' } }),
  EngineProvider: ({ children }: { children: ReactNode }) => children,
}))

const stem = (track: string, name: string): StemFile => ({
  name,
  file: `${track} - ${name}.wav`,
  path: `D:\\out\\${track}\\full-song\\${track} - ${name}.wav`,
  peaks: `D:\\out\\${track}\\full-song\\.peaks\\${name}.json`,
  samples: 88200,
  sample_rate: 44100,
})
const SIX = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

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
const doneJob = (id: string, track: string, finishedAt: number, names = SIX): Job =>
  job({ id, track_name: track, state: 'done', progress: 1, finished_at: finishedAt, stems: names.map((n) => stem(track, n)) })

const recipe = (patch: Partial<Recipe>): Recipe =>
  ({
    id: 'full-song',
    name: 'Full song',
    description: '',
    outputs: SIX,
    use_case: 'Full song',
    experimental: false,
    missing_models: [],
    download_bytes: 0,
    selectable_outputs: false,
    supports_sum_to_mix: true,
    ...patch,
  }) as Recipe

function tree(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ToastProvider>
          <SelectionProvider settings={settings}>{children}</SelectionProvider>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
const quickDrop = () => tree(<QuickDrop recipes={recipes} models={models} />)
const rows = () => screen.getAllByTestId('quick-row')
const lastActivity = () => bridge.reportActivity.mock.calls.at(-1)?.[0]

beforeEach(() => {
  vi.clearAllMocks()
  jobs = []
  recipes = [recipe({})]
  models = []
})

/* ---- where the window goes -------------------------------------------------------- */

const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1080 }
const SIZE = { width: 380, height: 500 }

describe('the taskbar edge', () => {
  it('is the side the work area is missing', () => {
    expect(taskbarEdge(SCREEN, { x: 0, y: 0, width: 1920, height: 1032 })).toBe('bottom')
    expect(taskbarEdge(SCREEN, { x: 0, y: 48, width: 1920, height: 1032 })).toBe('top')
    expect(taskbarEdge(SCREEN, { x: 48, y: 0, width: 1872, height: 1080 })).toBe('left')
    expect(taskbarEdge(SCREEN, { x: 0, y: 0, width: 1872, height: 1080 })).toBe('right')
  })

  it('follows the icon when the taskbar hides itself, and is the bottom when nothing says', () => {
    expect(taskbarEdge(SCREEN, SCREEN, { x: 1700, y: 1040, width: 24, height: 24 })).toBe('bottom')
    expect(taskbarEdge(SCREEN, SCREEN, { x: 1700, y: 8, width: 24, height: 24 })).toBe('top')
    expect(taskbarEdge(SCREEN, SCREEN, { x: 8, y: 500, width: 24, height: 24 })).toBe('left')
    expect(taskbarEdge(SCREEN, SCREEN)).toBe('bottom')
    expect(taskbarEdge(SCREEN, SCREEN, { x: 0, y: 0, width: 0, height: 0 })).toBe('bottom')
  })
})

describe('the quick-drop window position', () => {
  const bottom = { bounds: SCREEN, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }

  it('sits against the taskbar, centered on the tray icon', () => {
    const spot = popupPlacement({ x: 1500, y: 1044, width: 24, height: 24 }, bottom, SIZE)
    expect(spot).toEqual({ x: 1322, y: 520, width: 380, height: 500, edge: 'bottom' })
  })

  it('stays on the screen when the icon is near the corner', () => {
    const spot = popupPlacement({ x: 1880, y: 1044, width: 24, height: 24 }, bottom, SIZE)
    expect(spot.x).toBe(1920 - 380 - 12)
    expect(spot.y).toBe(1032 - 500 - 12)
  })

  it('goes to the tray corner when Windows gives no icon position', () => {
    for (const icon of [null, undefined, { x: 0, y: 0, width: 0, height: 0 }]) {
      expect(popupPlacement(icon, bottom, SIZE)).toMatchObject({ x: 1528, y: 520, edge: 'bottom' })
    }
  })

  it('follows a taskbar at the top, left or right', () => {
    const top = { bounds: SCREEN, workArea: { x: 0, y: 48, width: 1920, height: 1032 } }
    expect(popupPlacement({ x: 1500, y: 12, width: 24, height: 24 }, top, SIZE)).toMatchObject({ x: 1322, y: 60, edge: 'top' })
    const left = { bounds: SCREEN, workArea: { x: 48, y: 0, width: 1872, height: 1080 } }
    expect(popupPlacement({ x: 12, y: 900, width: 24, height: 24 }, left, SIZE)).toMatchObject({ x: 60, y: 568, edge: 'left' })
    const right = { bounds: SCREEN, workArea: { x: 0, y: 0, width: 1872, height: 1080 } }
    expect(popupPlacement({ x: 1884, y: 900, width: 24, height: 24 }, right, SIZE)).toMatchObject({ x: 1480, y: 568, edge: 'right' })
  })

  it('stays clear of a taskbar that hides itself', () => {
    const spot = popupPlacement({ x: 1500, y: 1044, width: 24, height: 24 }, { bounds: SCREEN, workArea: SCREEN }, SIZE)
    expect(spot).toMatchObject({ x: 1322, y: 1044 - 500 - 12, edge: 'bottom' })
  })

  it('works on a second screen to the left of the first, and shrinks on a screen too small', () => {
    const second = { bounds: { x: -1280, y: 0, width: 1280, height: 720 }, workArea: { x: -1280, y: 0, width: 1280, height: 680 } }
    expect(popupPlacement({ x: -200, y: 688, width: 24, height: 24 }, second, SIZE)).toMatchObject({ x: -392, y: 168, edge: 'bottom' })
    const small = { bounds: { x: 0, y: 0, width: 800, height: 480 }, workArea: { x: 0, y: 0, width: 800, height: 440 } }
    expect(popupPlacement(null, small, SIZE)).toEqual({ x: 408, y: 12, width: 380, height: 416, edge: 'bottom' })
  })
})

/* ---- what the icon says ------------------------------------------------------------- */

describe('the tray icon', () => {
  const done = { id: 'j1', name: 'First Song', stems: 6 }

  it('is idle with nothing going on', () => {
    expect(trayPresentation(null, null)).toEqual({ icon: 'idle', tooltip: 'OpenStems' })
    expect(trayPresentation({ active: 0, current: null, done: null }, null).icon).toBe('idle')
  })

  it('names the running job and how many wait behind it', () => {
    const one = trayPresentation({ active: 1, current: { name: 'First Song', progress: 0.416 }, done: null }, null)
    expect(one).toEqual({ icon: 'busy', tooltip: 'OpenStems: separating First Song, 42%' })
    const three = trayPresentation({ active: 3, current: { name: 'First Song', progress: 0.5 }, done }, null)
    expect(three.tooltip).toBe('OpenStems: separating First Song, 50% (2 waiting)')
    expect(trayPresentation({ active: 2, current: null, done: null }, null).tooltip).toBe('OpenStems: 2 queued')
  })

  it('says stems are ready until they have been seen', () => {
    const activity = { active: 0, current: null, done }
    expect(trayPresentation(activity, null)).toEqual({ icon: 'ready', tooltip: 'OpenStems: First Song is ready, 6 stems' })
    expect(trayPresentation(activity, 'j1').icon).toBe('idle')
    expect(trayPresentation({ ...activity, done: { ...done, stems: 1 } }, 'other').tooltip).toMatch(/1 stem$/)
  })

  it('keeps a long name inside the length Windows allows', () => {
    const name = 'A very long track name that goes on and on '.repeat(6)
    const busy = trayPresentation({ active: 1, current: { name, progress: 0.1 }, done: null }, null)
    const ready = trayPresentation({ active: 0, current: null, done: { id: 'x', name, stems: 6 } }, null)
    for (const tooltip of [busy.tooltip, ready.tooltip]) {
      expect(tooltip.length).toBeLessThanOrEqual(127)
      expect(tooltip).toContain('…')
    }
    expect(busy.tooltip).toMatch(/10%$/)
    expect(ready.tooltip).toMatch(/6 stems$/)
  })

  it('only accepts a well-formed report from the window', () => {
    expect(isTrayActivity({ active: 0, current: null, done: null })).toBe(true)
    expect(isTrayActivity({ active: 1, current: { name: 'a', progress: 0.5 }, done: { id: 'j', name: 'a', stems: 2 } })).toBe(true)
    expect(isTrayActivity(null)).toBe(false)
    expect(isTrayActivity({ active: '1', current: null, done: null })).toBe(false)
    expect(isTrayActivity({ active: 1, current: { name: 5 }, done: null })).toBe(false)
    expect(isTrayActivity({ active: 1, current: null, done: { id: 'j' } })).toBe(false)
  })

  it('summarizes the queue for the icon', () => {
    const list = [
      doneJob('a', 'Old', 1),
      job({ id: 'b', track_name: 'Now', state: 'running', progress: 0.4149 }),
      job({ id: 'c', track_name: 'Next' }),
      job({ id: 'd', state: 'failed' }),
    ]
    expect(activityOf(list, 'a')).toEqual({
      active: 2,
      current: { name: 'Now', progress: 0.41 },
      done: { id: 'a', name: 'Old', stems: 6 },
    })
    // A job that left the list, or never finished, announces nothing.
    expect(activityOf(list, 'gone').done).toBeNull()
    expect(activityOf(list, 'd').done).toBeNull()
  })
})

describe('the shell preferences', () => {
  it('default to staying in the tray', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('not json')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('[1]')).toEqual(DEFAULT_PREFS)
    expect(DEFAULT_PREFS.closeToTray).toBe(true)
  })

  it('keep what was saved and ignore what is not a switch', () => {
    expect(parsePrefs('{"closeToTray": false, "trayNoticeShown": true}')).toEqual({
      closeToTray: false,
      trayNoticeShown: true,
      checkForUpdates: true,
    })
    expect(parsePrefs('{"closeToTray": "no", "extra": 1}')).toEqual(DEFAULT_PREFS)
  })
})

/* ---- the window ------------------------------------------------------------------------ */

describe('the quick-drop window', () => {
  it('offers a drop target when the queue is empty, and queues picked files with the current recipe', () => {
    render(quickDrop())
    expect(screen.getByRole('heading', { name: 'Drop a song here' })).toBeInTheDocument()
    const file = new File(['x'], 'a.mp3')
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } })
    expect(createJobs.mutate).toHaveBeenCalledWith(
      { paths: ['C:/in/a.mp3'], recipe: 'full-song', quality: 'balanced', options: { sum_to_mix: false } },
      expect.anything(),
    )
  })

  it('lists the newest job first and lays out the stems of the latest finished one', () => {
    jobs = [doneJob('a', 'First', 10), doneJob('b', 'Second', 20), job({ id: 'c', track_name: 'Third', state: 'running', progress: 0.5 })]
    render(quickDrop())
    expect(rows().map((row) => row.getAttribute('data-state'))).toEqual(['running', 'done', 'done'])
    expect(within(rows()[0]!).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(within(rows()[1]!).getAllByTestId('quick-stem')).toHaveLength(6)
    expect(within(rows()[2]!).queryAllByTestId('quick-stem')).toHaveLength(0)
    expect(rows()[1]).toHaveAttribute('aria-expanded', 'true')
    expect(rows()[1]).toHaveTextContent('Full song · balanced')
  })

  it('lays out another job when it is clicked', () => {
    jobs = [doneJob('a', 'First', 10), doneJob('b', 'Second', 20)]
    render(quickDrop())
    fireEvent.click(rows()[1]!)
    expect(within(rows()[1]!).getAllByTestId('quick-stem')).toHaveLength(6)
    expect(within(rows()[0]!).queryAllByTestId('quick-stem')).toHaveLength(0)
  })

  it('drags one stem or all of them as real file paths, and shows a stem in Explorer from the keyboard', () => {
    jobs = [doneJob('a', 'First', 10)]
    render(quickDrop())
    const pills = screen.getAllByTestId('quick-stem')
    fireEvent.dragStart(pills[1]!)
    expect(bridge.startDrag).toHaveBeenLastCalledWith(['D:\\out\\First\\full-song\\First - drums.wav'])
    fireEvent.dragStart(screen.getByTestId('quick-drag-all'))
    expect(bridge.startDrag.mock.calls.at(-1)?.[0]).toHaveLength(6)
    fireEvent.keyDown(pills[0]!, { key: 'Enter' })
    expect(bridge.revealInExplorer).toHaveBeenCalledWith('D:\\out\\First\\full-song\\First - vocals.wav')
  })

  it('shows twelve stems and sends the rest to the full app', () => {
    const many = Array.from({ length: 20 }, (_, i) => `stem ${i + 1}`)
    jobs = [doneJob('a', 'First', 10, many)]
    render(quickDrop())
    expect(screen.getAllByTestId('quick-stem')).toHaveLength(12)
    expect(screen.getByTestId('quick-drag-all')).toHaveTextContent('20 stems')
    fireEvent.click(screen.getByRole('button', { name: '+8 in the full app' }))
    expect(bridge.showMain).toHaveBeenCalled()
  })

  it('cancels a running job, retries a failed one and clears the finished ones', () => {
    jobs = [job({ id: 'a', state: 'failed', error: 'Out of memory' }), job({ id: 'b', state: 'running', progress: 0.2 })]
    render(quickDrop())
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Cancel' }))
    expect(actions.cancel.mutate).toHaveBeenCalledWith('b', expect.anything())
    expect(rows()[1]).toHaveTextContent('Out of memory')
    fireEvent.click(within(rows()[1]!).getByRole('button', { name: 'Retry' }))
    expect(actions.retry.mutate).toHaveBeenCalledWith('a', expect.anything())
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }))
    expect(actions.clearFinished.mutate).toHaveBeenCalled()
  })

  it('tells the tray what the queue is doing, and announces only what finishes while it watches', () => {
    // Loading: nothing to say yet. Then a list with an old result in it: still nothing.
    jobs = undefined
    const view = render(quickDrop())
    jobs = [doneJob('old', 'Old', 5)]
    view.rerender(quickDrop())
    expect(lastActivity()).toEqual({ active: 0, current: null, done: null })

    jobs = [doneJob('old', 'Old', 5), job({ id: 'new', track_name: 'New', state: 'running', progress: 0.3 })]
    view.rerender(quickDrop())
    expect(lastActivity()).toEqual({ active: 1, current: { name: 'New', progress: 0.3 }, done: null })

    jobs = [doneJob('old', 'Old', 5), doneJob('new', 'New', 30)]
    view.rerender(quickDrop())
    expect(lastActivity()).toEqual({ active: 0, current: null, done: { id: 'new', name: 'New', stems: 6 } })
  })

  it('lets stems make an entrance only when they have just arrived', () => {
    jobs = [doneJob('old', 'Old', 5)]
    const view = render(quickDrop())
    const pillsOf = (row: HTMLElement) => row.querySelector('.stem-pills')
    expect(pillsOf(rows()[0]!)).toHaveAttribute('data-fresh', 'false')

    jobs = [doneJob('old', 'Old', 5), doneJob('new', 'New', 30)]
    view.rerender(quickDrop())
    expect(rows()[0]).toHaveTextContent('New')
    expect(pillsOf(rows()[0]!)).toHaveAttribute('data-fresh', 'true')

    // Picking the other job, then this one again: the stems are simply there.
    fireEvent.click(rows()[1]!)
    fireEvent.click(rows()[0]!)
    expect(pillsOf(rows()[0]!)).toHaveAttribute('data-fresh', 'false')
  })

  it('says when the recipe needs a download, and asks before starting one', () => {
    recipes = [recipe({ missing_models: ['m1'], download_bytes: 1_368_919_887 })]
    models = [{ id: 'm1', name: 'BS-RoFormer SW', bytes: 1_368_919_887, status: 'missing', stems: SIX } as unknown as Model]
    render(quickDrop())
    expect(screen.getByText(/Needs a 1\.3 GB download/)).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['x'], 'a.mp3')] } })
    expect(createJobs.mutate).not.toHaveBeenCalled()
    expect(screen.getByText('This recipe needs a download')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(modelActions.pull.mutate).toHaveBeenCalledWith('m1', expect.anything())
  })

  it('follows a recipe picked in the other window', () => {
    recipes = [recipe({}), recipe({ id: 'drum-kit', name: 'Drum kit', use_case: 'Drums' })]
    render(quickDrop())
    expect(screen.getByRole('combobox', { name: 'Recipe' })).toHaveTextContent('Full song')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'openstems.selection.v1', newValue: JSON.stringify({ target: 'drum-kit', quality: 'fast' }) }),
      )
    })
    expect(screen.getByRole('combobox', { name: 'Recipe' })).toHaveTextContent('Drum kit')
    expect(screen.getByRole('radio', { name: 'Fast' })).toBeChecked()
  })
})

describe('the quick-drop window frame', () => {
  it('hides on Escape and with its button, and opens the full app', async () => {
    render(<TrayApp />)
    expect(await screen.findByRole('heading', { name: 'Drop a song here' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bridge.hidePopup).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(bridge.hidePopup).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Open the full app' }))
    expect(bridge.showMain).toHaveBeenCalled()
  })

  it('leaves Escape to a list that is open', async () => {
    render(<TrayApp />)
    await screen.findByRole('heading', { name: 'Drop a song here' })
    const list = document.createElement('div')
    list.setAttribute('role', 'listbox')
    document.body.append(list)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(bridge.hidePopup).not.toHaveBeenCalled()
    list.remove()
  })

  it('sends the user to the full app while setup has not run', async () => {
    bridge.setup.mockResolvedValueOnce({ state: 'needed', log: [], managed: true, variant: 'cuda', installed: null, detected: true, gpus: [], note: '' })
    render(<TrayApp />)
    expect(await screen.findByRole('heading', { name: 'The audio engine is not set up yet' })).toBeInTheDocument()
    // The header has the same action as an icon; this is the one in the message.
    fireEvent.click(screen.getAllByRole('button', { name: 'Open the full app' }).at(-1)!)
    expect(bridge.showMain).toHaveBeenCalled()
  })
})

describe('the tray settings', () => {
  it('saves each switch through the main process', async () => {
    render(tree(<TraySettings />))
    const keep = await screen.findByRole('switch', { name: 'Keep running in the tray' })
    expect(keep).toBeChecked()
    await act(async () => {
      fireEvent.click(keep)
    })
    expect(bridge.setShell).toHaveBeenLastCalledWith({ closeToTray: false })
    expect(screen.getByRole('switch', { name: 'Keep running in the tray' })).not.toBeChecked()
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Start with Windows' }))
    })
    expect(bridge.setShell).toHaveBeenLastCalledWith({ startAtLogin: true })
  })

  it('leaves out "Start with Windows" where the app cannot register itself', async () => {
    bridge.shellStatus.mockResolvedValueOnce({ closeToTray: true, checkForUpdates: true, startAtLogin: false, canStartAtLogin: false })
    render(tree(<TraySettings />))
    await screen.findByRole('switch', { name: 'Keep running in the tray' })
    expect(screen.queryByRole('switch', { name: 'Start with Windows' })).not.toBeInTheDocument()
  })
})
