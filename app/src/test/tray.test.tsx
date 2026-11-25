import { existsSync, readFileSync } from 'node:fs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PREFS,
  type Rect,
  TITLE_BAR_HEIGHT,
  TRAFFIC_LIGHTS,
  TRAFFIC_LIGHTS_INSET,
  isTrayActivity,
  macMenuTemplate,
  menuBarPlacement,
  parsePrefs,
  popupChrome,
  popupPlacement,
  quitsOnWindowClose,
  readyNotice,
  startsHidden,
  taskbarEdge,
  trayIconFile,
  trayUpdateOf,
  trayClickAction,
  trayMenuTemplate,
  trayPresentation,
  windowChrome,
  titleBarOverlay,
  WINDOW_COLORS,
  THEME_PREFS,
  isThemePref,
} from '../../electron/traylogic'
import type { Job, Link, Model, Recipe, StemFile, SystemInfo } from '@/api/client'
import { ToastProvider } from '@/components/toast'
import { TooltipProvider } from '@/components/ui'
import { SelectionProvider } from '@/state/selection'
import TrayApp, { QuickDrop, activityOf, pillCount } from '@/tray/TrayApp'
import { TraySettings } from '@/views/SettingsView'
import { bridge } from './setup'

const createJobs = { mutate: vi.fn() }
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
const modelActions = { pull: { mutate: vi.fn() }, cancel: { mutate: vi.fn() } }
const patchSettings = { mutate: vi.fn() }
let jobs: Job[] | undefined = []
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
let recipes: Recipe[] = []
let models: Model[] = []

const settings = {
  default_recipe: 'full-song',
  default_quality: 'balanced',
  sum_to_mix: false,
  output_format: 'wav32f',
} as Parameters<typeof SelectionProvider>[0]['settings']

vi.mock('@/api/queries', () => ({
  keys: { jobs: ['jobs'] },
  useJobs: () => ({ data: jobs }),
  useJobActions: () => actions,
  useSetAnalysis: () => setAnalysis,
  useLinks: () => ({ data: links }),
  useLinkActions: () => linkActions,
  useCreateMix: () => createMix,
  useSystem: () => ({ data: system }),
  useCreateJobs: () => createJobs,
  useModelActions: () => modelActions,
  useSettings: () => ({ data: settings }),
  usePatchSettings: () => patchSettings,
  useRecipes: () => ({ data: recipes }),
  useModels: () => ({ data: { models } }),
}))
// Stands in for Web Audio, which jsdom does not have: records what was asked to play.
const audition = vi.hoisted(() => {
  type State = { path: string | null; status: 'idle' | 'loading' | 'playing'; error?: string }
  const listeners = new Set<() => void>()
  const player = {
    state: { path: null, status: 'idle' } as State,
    toggle: vi.fn(async (_stem: { path: string; url: string; group: string }) => undefined),
    stop: vi.fn(),
    dispose: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(state: State) {
      player.state = state
      for (const listener of listeners) listener()
    },
  }
  return player
})
vi.mock('@/audio/audition', () => ({
  Audition: vi.fn(function Audition() {
    return audition
  }),
}))

// The synced player of a mix, stood in for the same way.
const mixPlayer = vi.hoisted(() => {
  type State = { status: 'idle' | 'loading' | 'ready' | 'error'; loaded: number; total: number; playing: boolean; muted: Set<string> }
  const listeners = new Set<() => void>()
  const idle = (): State => ({ status: 'idle', loaded: 0, total: 0, playing: false, muted: new Set() })
  const player = {
    state: idle(),
    idle,
    set(patch: Partial<State>) {
      player.state = { ...player.state, ...patch }
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: vi.fn(async (_stems: { name: string; url: string }[]) => player.set({ status: 'ready' })),
    play: vi.fn(async () => player.set({ playing: true })),
    pause: vi.fn(() => player.set({ playing: false })),
    toggle: vi.fn(() => player.set({ playing: !player.state.playing })),
    setMuted: vi.fn((names: Iterable<string>) => player.set({ muted: new Set(names) })),
    dispose: vi.fn(() => player.set({ status: 'idle', playing: false })),
  }
  return player
})
vi.mock('@/audio/player', () => ({
  StemPlayer: vi.fn(function StemPlayer() {
    return mixPlayer
  }),
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
  start: 0,
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
  held: false,
  created_at: 0,
  started_at: null,
  finished_at: null,
  notes: [],
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
  audition.state = { path: null, status: 'idle' }
  mixPlayer.state = mixPlayer.idle()
  jobs = []
  links = []
  recipes = [recipe({})]
  models = []
  system = undefined
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

describe('the quick-drop window position on a Mac', () => {
  // A 1512 by 982 screen with a 38 point menu bar (a notch) and the Dock at the bottom.
  const MAC_SCREEN: Rect = { x: 0, y: 0, width: 1512, height: 982 }
  const dockBottom = { bounds: MAC_SCREEN, workArea: { x: 0, y: 38, width: 1512, height: 874 } }
  const item = { x: 1200, y: 0, width: 30, height: 38 }

  it('hangs under the menu bar, centered on the menu bar item', () => {
    expect(menuBarPlacement(item, dockBottom, SIZE)).toEqual({ x: 1025, y: 44, width: 380, height: 500, edge: 'top' })
  })

  it('stays at the top when the Dock takes more of the screen than the menu bar does', () => {
    // The Windows rule reads the edge from the largest inset, which here is the Dock.
    expect(popupPlacement(item, dockBottom, SIZE).edge).toBe('bottom')
    expect(menuBarPlacement(item, dockBottom, SIZE).y).toBe(44)
    const dockLeft = { bounds: MAC_SCREEN, workArea: { x: 80, y: 25, width: 1432, height: 957 } }
    expect(menuBarPlacement({ x: 1200, y: 0, width: 30, height: 24 }, dockLeft, SIZE)).toMatchObject({ x: 1025, y: 31, edge: 'top' })
  })

  it('stays on the screen beside an item near either end of the bar', () => {
    expect(menuBarPlacement({ x: 1480, y: 0, width: 30, height: 38 }, dockBottom, SIZE).x).toBe(1512 - 380 - 12)
    const dockLeft = { bounds: MAC_SCREEN, workArea: { x: 80, y: 38, width: 1432, height: 944 } }
    expect(menuBarPlacement({ x: 100, y: 0, width: 30, height: 38 }, dockLeft, SIZE).x).toBe(80 + 12)
  })

  it('stays clear of a menu bar that hides itself, as over a full-screen app', () => {
    const hidden = { bounds: MAC_SCREEN, workArea: MAC_SCREEN }
    expect(menuBarPlacement(item, hidden, SIZE)).toMatchObject({ x: 1025, y: 44 })
  })

  it('goes to the top right corner when macOS gives no item position', () => {
    for (const icon of [null, undefined, { x: 0, y: 0, width: 0, height: 0 }]) {
      expect(menuBarPlacement(icon, dockBottom, SIZE)).toEqual({ x: 1120, y: 44, width: 380, height: 500, edge: 'top' })
    }
  })

  it('works on a second screen above the first, and shrinks on a screen too small', () => {
    const above = { bounds: { x: 200, y: -1080, width: 1920, height: 1080 }, workArea: { x: 200, y: -1055, width: 1920, height: 1055 } }
    expect(menuBarPlacement({ x: 1900, y: -1080, width: 30, height: 24 }, above, SIZE)).toMatchObject({ x: 1725, y: -1049 })
    const small = { bounds: { x: 0, y: 0, width: 800, height: 500 }, workArea: { x: 0, y: 25, width: 800, height: 405 } }
    expect(menuBarPlacement(null, small, SIZE)).toEqual({ x: 408, y: 31, width: 380, height: 387, edge: 'top' })
  })
})

/* ---- Windows and Mac ---------------------------------------------------------------- */

describe('what differs between Windows and a Mac', () => {
  it('keeps the frame of the full window on Windows, and puts the three buttons in the title bar on a Mac', () => {
    expect(windowChrome('win32', 'dark')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0c0d0f', symbolColor: '#8b8f98', height: 40 },
    })
    const chrome = windowChrome('darwin', 'dark')
    expect(chrome).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 12 } })
    expect(chrome).not.toHaveProperty('titleBarOverlay')
    // A button's frame is 16 points high: centered in the title bar.
    expect(TRAFFIC_LIGHTS.y + 16 / 2).toBe(TITLE_BAR_HEIGHT / 2)
    // Three frames of 14, 6 apart, end before the room the page leaves for them.
    expect(TRAFFIC_LIGHTS.x + 3 * 14 + 2 * 6).toBeLessThan(TRAFFIC_LIGHTS_INSET)
  })

  it('paints the Windows title bar buttons for the theme, and leaves a Mac its own', () => {
    expect(windowChrome('win32', 'light').titleBarOverlay).toEqual({ color: '#f7f8f9', symbolColor: '#5b616b', height: 40 })
    expect(titleBarOverlay('dark')).toEqual({ color: WINDOW_COLORS.dark.background, symbolColor: WINDOW_COLORS.dark.symbol, height: 40 })
    expect(windowChrome('darwin', 'light')).toEqual(windowChrome('darwin', 'dark'))
  })

  it('matches the window background and title bar buttons to the page, in both themes', () => {
    const css = readFileSync('src/styles.css', 'utf8') // vitest runs from app/
    const block = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)))
    const token = (text: string, name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`).exec(text)?.[1]
    const dark = block('@theme {')
    const light = block(":root[data-theme='light'] {")
    expect(token(dark, 'bg')).toBe(WINDOW_COLORS.dark.background)
    expect(token(dark, 'muted')).toBe(WINDOW_COLORS.dark.symbol)
    expect(token(light, 'bg')).toBe(WINDOW_COLORS.light.background)
    expect(token(light, 'muted')).toBe(WINDOW_COLORS.light.symbol)
  })

  it('makes the quick-drop window a tool window on Windows and a panel on a Mac', () => {
    expect(popupChrome('win32')).toEqual({ skipTaskbar: true, type: 'toolbar' })
    expect(popupChrome('darwin')).toEqual({ type: 'panel', hiddenInMissionControl: true })
  })

  it('uses .ico files on Windows and template images on a Mac', () => {
    expect((['idle', 'busy', 'ready', 'update'] as const).map((icon) => trayIconFile(icon, 'win32'))).toEqual([
      'tray.ico',
      'tray-busy.ico',
      'tray-ready.ico',
      'tray-update.ico',
    ])
    expect((['idle', 'busy', 'ready', 'update'] as const).map((icon) => trayIconFile(icon, 'darwin'))).toEqual([
      'trayTemplate.png',
      'tray-busyTemplate.png',
      'tray-readyTemplate.png',
      'tray-updateTemplate.png',
    ])
    // Every file named here exists, with the @2x picture a Mac asks for beside its template.
    for (const icon of ['idle', 'busy', 'ready', 'update'] as const) {
      expect(existsSync(`resources/${trayIconFile(icon, 'win32')}`)).toBe(true)
      expect(existsSync(`resources/${trayIconFile(icon, 'darwin').replace('.png', '@2x.png')}`)).toBe(true)
    }
  })

  it('quits with the window on Windows unless the app stays in the tray, and never on a Mac', () => {
    expect(quitsOnWindowClose('win32', true, true)).toBe(false)
    expect(quitsOnWindowClose('win32', false, true)).toBe(true)
    expect(quitsOnWindowClose('win32', true, false)).toBe(true)
    for (const closeToTray of [true, false]) {
      for (const hasTray of [true, false]) expect(quitsOnWindowClose('darwin', closeToTray, hasTray)).toBe(false)
    }
  })

  it('starts without a window with --tray, and on a Mac when opened at login', () => {
    expect(startsHidden('win32', ['OpenStems.exe', '--tray'], false)).toBe(true)
    expect(startsHidden('win32', ['OpenStems.exe'], false)).toBe(false)
    // Only a Mac reports a launch at login; elsewhere the answer means nothing.
    expect(startsHidden('win32', ['OpenStems.exe'], true)).toBe(false)
    expect(startsHidden('darwin', ['OpenStems'], true)).toBe(true)
    expect(startsHidden('darwin', ['OpenStems'], false)).toBe(false)
    expect(startsHidden('darwin', ['OpenStems', '--tray'], false)).toBe(true)
  })

  it('toggles the quick-drop window on a click, and raises the menu by itself only on a Mac', () => {
    // Windows, as it always was: the menu is set on the icon and Windows raises it.
    expect(trayClickAction('win32', 'click')).toBe('toggle')
    expect(trayClickAction('win32', 'double-click')).toBe('main')
    expect(trayClickAction('win32', 'right-click')).toBeNull()
    // Control means nothing to the Windows tray.
    expect(trayClickAction('win32', 'click', true)).toBe('toggle')
    expect(trayClickAction('darwin', 'click')).toBe('toggle')
    expect(trayClickAction('darwin', 'click', true)).toBe('menu')
    expect(trayClickAction('darwin', 'right-click')).toBe('menu')
    expect(trayClickAction('darwin', 'double-click')).toBeNull()
  })

  it('offers the same tray menu on both, worded for each', () => {
    const host = { quickDrop: vi.fn(), openMain: vi.fn(), quit: vi.fn() }
    const windows = trayMenuTemplate('win32', host)
    expect(windows.map((item) => item.label ?? item.type)).toEqual(['Quick drop', 'Show OpenStems', 'separator', 'Quit OpenStems'])
    const macos = trayMenuTemplate('darwin', host)
    expect(macos.map((item) => item.label ?? item.type)).toEqual(['Quick Drop', 'Show OpenStems', 'separator', 'Quit OpenStems'])
    ;(macos[3]?.click as () => void)()
    expect(host.quit).toHaveBeenCalledOnce()
  })

  it('gives a Mac the menu its standard shortcuts live in', () => {
    const host = { name: 'OpenStems', settings: vi.fn(), open: vi.fn() }
    const menu = macMenuTemplate(host)
    const submenu = (index: number) => menu[index]?.submenu as { role?: string; label?: string; accelerator?: string; click?: () => void }[]
    const roles = (index: number) => submenu(index).flatMap((item) => (item.role ? [item.role] : []))

    expect(menu.map((item) => item.label ?? item.role)).toEqual(['OpenStems', 'File', 'Edit', 'windowMenu', 'help'])
    expect(roles(0)).toEqual(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit'])
    expect(roles(1)).toEqual(['close'])
    expect(roles(2)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])

    // The items with the app's name in them say OpenStems, not the package's name.
    const labelOf = (role: string) => submenu(0).find((item) => item.role === role)?.label
    expect([labelOf('about'), labelOf('hide'), labelOf('quit')]).toEqual(['About OpenStems', 'Hide OpenStems', 'Quit OpenStems'])

    const settings = submenu(0).find((item) => item.label === 'Settings…')
    expect(settings?.accelerator).toBe('Command+,')
    settings?.click?.()
    expect(host.settings).toHaveBeenCalledOnce()
    // Help opens the website first, and the code last.
    const help = submenu(4).filter((item) => item.label)
    expect(help.map((item) => item.label)).toEqual(['OpenStems Website', "What's New", 'Support OpenStems', 'OpenStems on GitHub'])
    for (const item of help) item.click?.()
    expect(host.open.mock.calls.map((call) => call[0])).toEqual([
      'https://lewisgoing.github.io/OpenStems/',
      'https://lewisgoing.github.io/OpenStems/#changelog',
      'https://lewisgoing.github.io/OpenStems/#support',
      'https://github.com/lewisgoing/OpenStems',
    ])
  })
})

/* ---- what the icon says ------------------------------------------------------------- */

describe('the tray icon', () => {
  const done = { id: 'j1', name: 'First Song', stems: 6 }

  it('is idle with nothing going on', () => {
    expect(trayPresentation(null, null)).toEqual({ icon: 'idle', tooltip: 'OpenStems' })
    expect(trayPresentation(null, null, null).icon).toBe('idle')
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

  it('words the notification for one song or for several', () => {
    expect(readyNotice({ name: 'First Song', stems: 6 }, 1)).toEqual({
      title: 'First Song is ready',
      content: '6 stems. Click to drag them out.',
    })
    expect(readyNotice({ name: 'First Song', stems: 1 }, 0).content).toBe('1 stem. Click to drag them out.')
    expect(readyNotice({ name: 'Third Song', stems: 6 }, 3)).toEqual({
      title: '3 songs are ready',
      content: 'Click to drag their stems out.',
    })
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
    // Songs that wait for Start are not work in progress.
    expect(activityOf([job({ id: 'w', held: true }), job({ id: 'x', held: true })], null)).toEqual({
      active: 0,
      current: null,
      done: null,
    })
    // A job that left the list, or never finished, announces nothing.
    expect(activityOf(list, 'gone').done).toBeNull()
    expect(activityOf(list, 'd').done).toBeNull()
  })
})

describe('a new version on the tray icon', () => {
  it('marks the icon while a version waits, from the offer to the restart', () => {
    expect(trayUpdateOf(null)).toBeNull()
    expect(trayUpdateOf({ state: 'idle' })).toBeNull()
    expect(trayUpdateOf({ state: 'checking', version: '0.3.6' })).toBeNull()
    expect(trayUpdateOf({ state: 'available', version: '0.3.6' })).toEqual({ version: '0.3.6', ready: false })
    expect(trayUpdateOf({ state: 'downloading', version: '0.3.6' })).toEqual({ version: '0.3.6', ready: false })
    expect(trayUpdateOf({ state: 'ready', version: '0.3.6' })).toEqual({ version: '0.3.6', ready: true })
    // An app that cannot install it itself (an unsigned Mac app) only offers the page.
    expect(trayUpdateOf({ state: 'ready', version: '0.3.6', manual: true })?.ready).toBe(false)

    const offer = { version: '0.3.6', ready: false }
    expect(trayPresentation(null, null, offer)).toEqual({ icon: 'update', tooltip: 'OpenStems: version 0.3.6 is available' })
    expect(trayPresentation(null, null, { ...offer, ready: true }).tooltip).toBe(
      'OpenStems: version 0.3.6 is downloaded: restart to install it',
    )
  })

  it('gives way to work in progress and to stems that are waiting', () => {
    const offer = { version: '0.3.6', ready: false }
    const done = { id: 'j1', name: 'First Song', stems: 6 }
    expect(trayPresentation({ active: 1, current: { name: 'First Song', progress: 0.5 }, done: null }, null, offer).icon).toBe('busy')
    expect(trayPresentation({ active: 0, current: null, done }, null, offer).icon).toBe('ready')
    // Once those stems are seen, the version is what the icon has left to say.
    expect(trayPresentation({ active: 0, current: null, done }, 'j1', offer).icon).toBe('update')
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
    expect(parsePrefs('{"closeToTray": false, "trayNoticeShown": true, "notifyReady": false}')).toEqual({
      closeToTray: false,
      trayNoticeShown: true,
      checkForUpdates: true,
      notifyReady: false,
      theme: 'dark',
    })
    expect(parsePrefs('{"closeToTray": "no", "extra": 1}')).toEqual(DEFAULT_PREFS)
  })

  it('stay dark until the user picks a theme, and keep only a theme they could pick', () => {
    expect(DEFAULT_PREFS.theme).toBe('dark')
    expect(parsePrefs('{"theme": "light"}').theme).toBe('light')
    expect(parsePrefs('{"theme": "system"}').theme).toBe('system')
    expect(parsePrefs('{"theme": "sepia"}').theme).toBe('dark')
    expect(parsePrefs('{"theme": true}').theme).toBe('dark')
    expect(THEME_PREFS.every(isThemePref)).toBe(true)
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

  it('drags one stem or all of them as real file paths', () => {
    jobs = [doneJob('a', 'First', 10)]
    render(quickDrop())
    const pills = screen.getAllByTestId('quick-stem')
    fireEvent.dragStart(pills[1]!)
    expect(bridge.startDrag).toHaveBeenLastCalledWith(['D:\\out\\First\\full-song\\First - drums.wav'])
    fireEvent.dragStart(screen.getByTestId('quick-drag-all'))
    expect(bridge.startDrag.mock.calls.at(-1)?.[0]).toHaveLength(6)
    // A drag is not a click: nothing starts playing.
    expect(audition.toggle).not.toHaveBeenCalled()
  })

  it('drags the original song by its title: a fetched link becomes a file', () => {
    jobs = [{ ...doneJob('a', 'First', 10), track_path: 'D:/out/_links/First.webm' }]
    render(quickDrop())
    fireEvent.dragStart(screen.getByRole('button', { name: 'Drag the original file of First' }))
    expect(bridge.startDrag).toHaveBeenLastCalledWith(['D:/out/_links/First.webm'])
  })

  it('plays a stem when its pill is clicked, by pointer or keyboard, and shows which one plays', () => {
    jobs = [doneJob('a', 'First', 10)]
    render(quickDrop())
    const pills = screen.getAllByTestId('quick-stem')
    fireEvent.click(pills[1]!)
    expect(audition.toggle).toHaveBeenLastCalledWith({
      path: 'D:\\out\\First\\full-song\\First - drums.wav',
      url: expect.stringContaining('/v1/files?path='),
      group: 'a',
    })
    fireEvent.keyDown(pills[0]!, { key: 'Enter' })
    fireEvent.keyDown(pills[0]!, { key: ' ' })
    expect(audition.toggle).toHaveBeenCalledTimes(3)

    expect(pills[1]).toHaveAccessibleName('Play drums')
    act(() => audition.set({ path: 'D:\\out\\First\\full-song\\First - drums.wav', status: 'loading' }))
    expect(pills[1]).toHaveAttribute('data-audition', 'loading')
    act(() => audition.set({ path: 'D:\\out\\First\\full-song\\First - drums.wav', status: 'playing' }))
    expect(pills[1]).toHaveAttribute('data-audition', 'playing')
    expect(pills[1]).toHaveAttribute('aria-pressed', 'true')
    expect(pills[1]).toHaveAccessibleName('Stop drums')
    expect(pills[1]!.querySelector('.audition-bars')).not.toBeNull()
    expect(pills[0]).not.toHaveAttribute('data-audition')
  })

  it('stops playing when another song is laid out, and when the window is put away', () => {
    jobs = [doneJob('a', 'First', 10), doneJob('b', 'Second', 20)]
    render(quickDrop())
    act(() => audition.set({ path: 'D:\\out\\Second\\full-song\\Second - bass.wav', status: 'playing' }))
    expect(audition.stop).not.toHaveBeenCalled()
    fireEvent.click(rows()[1]!) // lay out First: Second's stems are gone from view
    expect(audition.stop).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    fireEvent(document, new Event('visibilitychange'))
    expect(audition.stop).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
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

  it('shows a thirteenth stem rather than a pill saying one is hidden', () => {
    // A "+1" pill would take the room the stem itself needs (every-stem writes 13).
    expect([12, 13, 14, 53].map(pillCount)).toEqual([12, 13, 12, 12])
    const thirteen = Array.from({ length: 13 }, (_, i) => `stem ${i + 1}`)
    jobs = [doneJob('a', 'First', 10, thirteen)]
    render(quickDrop())
    expect(screen.getAllByTestId('quick-stem')).toHaveLength(13)
    expect(screen.queryByRole('button', { name: /in the full app/ })).not.toBeInTheDocument()
    // All of them can be seen, so they can be mixed here too.
    expect(screen.getByRole('button', { name: /Mix/ })).toBeInTheDocument()
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

  it('offers Start while songs wait for it, for all of them or for one', () => {
    jobs = [job({ id: 'a', track_name: 'One', held: true }), job({ id: 'b', track_name: 'Two', held: true })]
    render(quickDrop())
    expect(rows()[0]).toHaveTextContent('Ready to start')
    fireEvent.click(screen.getByRole('button', { name: 'Start 2 songs' }))
    expect(actions.startAll.mutate).toHaveBeenCalledTimes(1)
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'Start this one' }))
    expect(actions.start.mutate).toHaveBeenCalledWith('b', expect.anything())
    // From the keyboard: Ctrl+Enter.
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(actions.startAll.mutate).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(actions.startAll.mutate).toHaveBeenCalledTimes(2)
  })

  it('says a waiting song separates only its part while the setting is on, as the full window does', () => {
    const part = { range: { start: 2.5, end: 4.5, label: 'bar 2' } }
    jobs = [job({ id: 'a', track_name: 'One', held: true, options: part }), job({ id: 'b', track_name: 'Two', held: true })]
    const shown = settings as Record<string, unknown>
    shown.separate_selection = true
    try {
      const view = render(quickDrop())
      expect(rows()[1]).toHaveTextContent('Ready to start, bar 2 only')
      expect(rows()[0]).toHaveTextContent('Ready to start')
      expect(rows()[0]).not.toHaveTextContent('only')
      view.unmount()
      // Off: the whole song is separated, whatever part it was given.
      shown.separate_selection = false
      render(quickDrop())
      expect(rows()[1]).not.toHaveTextContent('only')
    } finally {
      delete shown.separate_selection
    }
  })

  it('has no Start button when nothing waits', () => {
    jobs = [job({ id: 'a', state: 'running', progress: 0.2 }), job({ id: 'b' })]
    render(quickDrop())
    expect(screen.queryByRole('button', { name: /^Start/ })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(actions.startAll.mutate).not.toHaveBeenCalled()
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

  it('says nothing about memory when the recipe fits', () => {
    system = { cuda_available: true, gpu_backend: 'cuda', memory_budget_gb: 15.9, memory_gb: 15.9 }
    recipes = [recipe({ fit: 'fits', fit_model: 'm1', memory_gb: 3.8 })]
    render(quickDrop())
    expect(screen.queryByTestId('fit-note')).not.toBeInTheDocument()
  })

  it('says in full when the recipe is tight or too large, on a Mac and on Windows, and still takes a drop', () => {
    const leap = { id: 'leap', name: 'BS-RoFormer Leap Xe', bytes: 1, status: 'installed', stems: SIX, fit: 'no', memory_gb: 7.2 } as unknown as Model
    models = [leap]
    recipes = [recipe({ fit: 'no', fit_model: 'leap', memory_gb: 7.2 })]
    system = { cuda_available: true, gpu_backend: 'cuda', memory_budget_gb: 6, memory_gb: 6 }
    const { unmount } = render(quickDrop())
    expect(screen.getByTestId('fit-note')).toHaveTextContent(
      'BS-RoFormer Leap Xe needs about 7.2 GB. This PC has about 6.0 GB of VRAM for a model. It may not fit. If it does not, it runs on the CPU, which is much slower.',
    )
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [new File(['x'], 'a.mp3')] } })
    expect(createJobs.mutate).toHaveBeenCalledTimes(1)
    unmount()

    bridge.info.platform = 'darwin'
    try {
      recipes = [recipe({ fit: 'tight', fit_model: 'leap', memory_gb: 4.2 })]
      system = { cuda_available: true, gpu_backend: 'mps', memory_budget_gb: 4.5, memory_gb: 8 }
      render(quickDrop())
      const note = screen.getByTestId('fit-note')
      expect(note).toHaveTextContent(
        'BS-RoFormer Leap Xe needs about 4.2 GB. This Mac has about 4.5 GB of memory for a model. It should fit. If it does not, it runs on the CPU, which is much slower.',
      )
      expect(note.className).not.toMatch(/warn|danger/)
    } finally {
      bridge.info.platform = 'win32'
    }
  })

  it('shows under a job what did not go as planned', () => {
    jobs = [doneJob('a', 'Song', 1), { ...doneJob('b', 'Other', 2), notes: ['BS-RoFormer SW ran on the CPU: not enough GPU memory'] }]
    render(quickDrop())
    const [newest, older] = rows()
    expect(within(newest!).getByRole('note')).toHaveTextContent('BS-RoFormer SW ran on the CPU: not enough GPU memory')
    expect(within(older!).queryByRole('note')).not.toBeInTheDocument()
  })

  it('shows the output format and changes the setting when another is picked', async () => {
    const user = userEvent.setup()
    render(quickDrop())
    const format = screen.getByRole('combobox', { name: 'Output format' })
    expect(format).toHaveTextContent('WAV 32')
    await user.click(format)
    await user.click(await screen.findByRole('option', { name: /MP3 320 kbps/ }))
    expect(patchSettings.mutate).toHaveBeenCalledWith({ output_format: 'mp3' }, expect.anything())
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

describe('links in the quick-drop window', () => {
  it('offers Paste link in the empty window and takes the link on the clipboard', async () => {
    bridge.clipboardText.mockResolvedValueOnce('https://youtu.be/abc123\n')
    render(quickDrop())
    expect(screen.getByText(/Or paste a link to one/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Paste link' }))
    await waitFor(() =>
      expect(linkActions.add.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://youtu.be/abc123', recipe: 'full-song', quality: 'balanced' }),
        expect.anything(),
      ),
    )
    expect(createJobs.mutate).not.toHaveBeenCalled()
  })

  it('says what to do when the clipboard holds no link', async () => {
    jobs = [doneJob('a', 'Song', 1)]
    bridge.clipboardText.mockResolvedValueOnce('just some words')
    render(quickDrop())
    await userEvent.click(screen.getByRole('button', { name: 'Paste a link' }))
    expect(await screen.findByText("Copy a song's link first, then paste it here.")).toBeInTheDocument()
    expect(linkActions.add.mutate).not.toHaveBeenCalled()
  })

  it('fetches a link pasted with Ctrl+V, and leaves other text alone', () => {
    render(quickDrop())
    const paste = (text: string) =>
      fireEvent.paste(document.body, { clipboardData: { getData: () => text, files: [] } })
    paste('some lyrics')
    expect(linkActions.add.mutate).not.toHaveBeenCalled()
    paste('https://soundcloud.com/artist/song')
    expect(linkActions.add.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://soundcloud.com/artist/song' }),
      expect.anything(),
    )
  })

  it('shows a song being fetched above the jobs, and cancels it', async () => {
    jobs = [doneJob('a', 'Song', 1)]
    links = [link({ name: 'Night Drive', state: 'downloading', progress: 0.4 })]
    render(quickDrop())
    const list = screen.getByRole('list', { name: 'Recent jobs' })
    expect(list.firstElementChild).toHaveAttribute('data-testid', 'link-row')
    const row = screen.getByTestId('link-row')
    expect(within(row).getByText('Night Drive')).toBeInTheDocument()
    expect(within(row).getByText('40%')).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect(linkActions.remove.mutate).toHaveBeenCalledWith('l1', expect.anything())
  })

  it('shows a fetch with no jobs yet instead of the empty window', () => {
    links = [link({})]
    render(quickDrop())
    expect(screen.queryByRole('heading', { name: 'Drop a song here' })).not.toBeInTheDocument()
    expect(screen.getByTestId('link-status')).toHaveTextContent('Finding the song on youtube.com')
  })

  it('counts a fetch as work for the tray icon, but not one that failed', () => {
    expect(activityOf([], null, [link({})]).active).toBe(1)
    expect(activityOf([], null, [link({ state: 'failed', error: 'no' })]).active).toBe(0)
    links = [link({ state: 'downloading' })]
    render(quickDrop())
    expect(lastActivity()).toMatchObject({ active: 1 })
  })
})

describe('mixing the stems in the quick-drop window', () => {
  const pill = (name: string) => screen.getAllByTestId('quick-stem').find((el) => el.textContent === name)!
  const stemsOf = (track: string) => SIX.map((name) => stem(track, name))

  it('starts with every stem in, and says how to leave one out', async () => {
    jobs = [doneJob('a', 'Song', 1)]
    render(quickDrop())
    expect(screen.queryByTestId('mix-bar')).not.toBeInTheDocument()
    audition.set({ path: stem('Song', 'bass').path, status: 'playing' })
    await userEvent.click(screen.getByTestId('quick-mix'))
    expect(audition.stop).toHaveBeenCalled()
    expect(screen.getByTestId('quick-mix')).toHaveAttribute('aria-pressed', 'true')
    for (const el of screen.getAllByTestId('quick-stem')) {
      expect(el).toHaveAttribute('aria-pressed', 'true')
      expect(el).toHaveAttribute('data-mix', 'in')
    }
    expect(screen.getByTestId('mix-label')).toHaveTextContent('Click a stem to leave it out')
    expect(screen.queryByTestId('mix-drag')).not.toBeInTheDocument()
    expect(createMix.mutateAsync).not.toHaveBeenCalled()
  })

  it('leaves a stem out on a click, writes the rest as one file and drags it', async () => {
    jobs = [doneJob('a', 'Song', 1)]
    render(quickDrop())
    await userEvent.click(screen.getByTestId('quick-mix'))
    await userEvent.click(pill('vocals'))
    expect(audition.toggle).not.toHaveBeenCalled()
    expect(pill('vocals')).toHaveAttribute('aria-pressed', 'false')
    expect(pill('vocals')).toHaveAttribute('data-mix', 'out')
    expect(mixPlayer.setMuted).toHaveBeenLastCalledWith(['vocals'])
    expect(screen.getByTestId('mix-label')).toHaveTextContent('No vocals')
    expect(screen.getByTestId('mix-drag')).toHaveTextContent('Preparing')
    fireEvent.dragStart(screen.getByTestId('mix-drag'))
    expect(bridge.startDrag).not.toHaveBeenCalled()

    const rest = stemsOf('Song').slice(1).map((s) => s.path)
    await waitFor(() => expect(createMix.mutateAsync).toHaveBeenCalledWith(rest))
    await waitFor(() => expect(screen.getByTestId('mix-drag')).toHaveTextContent('Drag mix'))
    fireEvent.dragStart(screen.getByTestId('mix-drag'))
    expect(bridge.startDrag).toHaveBeenCalledWith([MIX_PATH])
    // The stem itself still drags as itself.
    fireEvent.dragStart(pill('drums'))
    expect(bridge.startDrag).toHaveBeenLastCalledWith([stem('Song', 'drums').path])
    // Back in: the whole song again, and nothing to write.
    await userEvent.click(pill('vocals'))
    expect(screen.getByTestId('mix-label')).toHaveTextContent('Click a stem to leave it out')
    expect(screen.queryByTestId('mix-drag')).not.toBeInTheDocument()
    expect(createMix.mutateAsync).toHaveBeenCalledTimes(1)
  })

  it('writes one file for several quick clicks, not one per click', async () => {
    jobs = [doneJob('a', 'Song', 1)]
    render(quickDrop())
    await userEvent.click(screen.getByTestId('quick-mix'))
    for (const name of ['vocals', 'guitar', 'piano', 'other']) await userEvent.click(pill(name))
    expect(screen.getByTestId('mix-label')).toHaveTextContent('Drums + bass')
    await waitFor(() => expect(createMix.mutateAsync).toHaveBeenCalledTimes(1))
    expect(createMix.mutateAsync).toHaveBeenCalledWith([stem('Song', 'drums').path, stem('Song', 'bass').path])
  })

  it('plays what is in the mix, in sync, and pauses', async () => {
    jobs = [doneJob('a', 'Song', 1)]
    render(quickDrop())
    await userEvent.click(screen.getByTestId('quick-mix'))
    await userEvent.click(pill('vocals'))
    await userEvent.click(screen.getByRole('button', { name: 'Play the mix' }))
    expect(mixPlayer.load).toHaveBeenCalledWith(SIX.map((name) => expect.objectContaining({ name })))
    await waitFor(() => expect(mixPlayer.play).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: 'Pause the mix' })).toBeInTheDocument()
    // The stems that sound show it; the one left out does not.
    expect(pill('drums').querySelector('.audition-bars')).not.toBeNull()
    expect(pill('vocals').querySelector('.audition-bars')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Pause the mix' }))
    expect(mixPlayer.toggle).toHaveBeenCalled()
  })

  it('hands over the stem itself when one is left, and nothing when none is', async () => {
    jobs = [doneJob('a', 'Song', 1)]
    render(quickDrop())
    await userEvent.click(screen.getByTestId('quick-mix'))
    for (const name of SIX.slice(1)) await userEvent.click(pill(name))
    expect(screen.getByTestId('mix-label')).toHaveTextContent('Vocals')
    fireEvent.dragStart(screen.getByTestId('mix-drag'))
    expect(bridge.startDrag).toHaveBeenCalledWith([stem('Song', 'vocals').path])
    await userEvent.click(pill('vocals'))
    expect(screen.getByTestId('mix-label')).toHaveTextContent('Nothing is in the mix')
    expect(screen.getByRole('button', { name: 'Play the mix' })).toBeDisabled()
    expect(screen.queryByTestId('mix-drag')).not.toBeInTheDocument()
  })

  it('goes back to listening to one stem when mixing is turned off or another song is laid out', async () => {
    jobs = [doneJob('a', 'Older', 1), doneJob('b', 'Newer', 2)]
    render(quickDrop())
    await userEvent.click(screen.getByTestId('quick-mix'))
    expect(screen.getByTestId('mix-bar')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('quick-mix'))
    expect(screen.queryByTestId('mix-bar')).not.toBeInTheDocument()
    expect(mixPlayer.dispose).toHaveBeenCalled()
    await userEvent.click(pill('bass'))
    expect(audition.toggle).toHaveBeenCalledWith(expect.objectContaining({ path: stem('Newer', 'bass').path }))

    await userEvent.click(screen.getByTestId('quick-mix'))
    await userEvent.click(rows()[1]!)
    expect(screen.queryByTestId('mix-bar')).not.toBeInTheDocument()
    expect(screen.getByTestId('quick-mix')).toHaveAttribute('aria-pressed', 'false')
  })

  it('offers no mix for a single stem, or for more stems than the window shows', () => {
    jobs = [doneJob('a', 'Solo', 1, ['vocals'])]
    const { unmount } = render(quickDrop())
    expect(screen.queryByTestId('quick-mix')).not.toBeInTheDocument()
    unmount()
    jobs = [doneJob('b', 'Many', 2, Array.from({ length: 20 }, (_, i) => `stem ${i}`))]
    render(quickDrop())
    expect(screen.queryByTestId('quick-mix')).not.toBeInTheDocument()
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

describe('the quick-drop window frame on a Mac', () => {
  const header = () => [...document.querySelectorAll('header button')].map((button) => button.getAttribute('aria-label'))

  it('has its Hide button at the left, where a Mac keeps the close button', async () => {
    bridge.info.platform = 'darwin'
    try {
      render(<TrayApp />)
      await screen.findByRole('heading', { name: 'Drop a song here' })
      expect(header()).toEqual(['Hide', 'Open the full app'])
      const hide = screen.getByRole('button', { name: 'Hide' })
      expect(hide.compareDocumentPosition(screen.getByText('OpenStems')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      fireEvent.click(hide)
      expect(bridge.hidePopup).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Paste link' })).toHaveAttribute('title', 'Fetch the song behind a copied link (⌘V)')
    } finally {
      bridge.info.platform = 'win32'
    }
  })

  it('keeps it at the right on Windows', async () => {
    render(<TrayApp />)
    await screen.findByRole('heading', { name: 'Drop a song here' })
    expect(header()).toEqual(['Open the full app', 'Hide'])
    expect(screen.getByRole('button', { name: 'Paste link' })).toHaveAttribute('title', 'Fetch the song behind a copied link (Ctrl+V)')
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
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Tell me when stems are ready' }))
    })
    expect(bridge.setShell).toHaveBeenLastCalledWith({ notifyReady: false })
  })

  it('leaves out "Start with Windows" where the app cannot register itself', async () => {
    bridge.shellStatus.mockResolvedValueOnce({
      closeToTray: true,
      checkForUpdates: true,
      notifyReady: true,
      theme: 'dark',
      startAtLogin: false,
      canStartAtLogin: false,
    })
    render(tree(<TraySettings />))
    await screen.findByRole('switch', { name: 'Keep running in the tray' })
    expect(screen.queryByRole('switch', { name: 'Start with Windows' })).not.toBeInTheDocument()
  })
})
