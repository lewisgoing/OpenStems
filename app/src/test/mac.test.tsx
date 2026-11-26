import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupStatus, UpdateStatus } from '../../electron/bridge'
import { recommendVariant } from '../../electron/variant'
import { SetupScreen } from '@/App'
import type { Job } from '@/api/client'
import { ToastProvider } from '@/components/toast'
import { TooltipProvider } from '@/components/ui'
import { UpdatePill, UpdateSettings, updateSummary } from '@/components/Update'
import { freeKey, homeKey, isMac, modClick, modKey, modName, shortcut, words } from '@/platform'
import { TrimEditor } from '@/trimmer/TrimEditor'
import { FRESH, type TrimMemory } from '@/trimmer/memory'
import { isZoomWheel, zoomFactor } from '@/trimmer/model'
import { songOfJob } from '@/trimmer/song'
import { QueueSearch, StartButton } from '@/views/QueueView'
import { EngineBuildRow, TraySettings, gpuHint, gpuMemory, selfTestLines } from '@/views/SettingsView'
import { bridge } from './setup'
import { TrimPlayer } from './trimstub'

// The trimmer is drawn here with its player, the engine and its queries stood in for; the
// other tests in this file use none of them.
vi.mock('@/audio/trimplayer', async () => await import('./trimstub'))
vi.mock('@/api/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/engine')>()),
  useEngine: () => ({
    api: { GET: async () => ({ data: undefined, error: { detail: 'no peaks here' }, response: { status: 404 } }) },
    connection: { baseUrl: 'http://127.0.0.1:1', token: 't' },
  }),
}))
vi.mock('@/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/queries')>()),
  useSourcePreview: () => ({ data: undefined, isPending: true, isError: false, error: null }),
  useSettings: () => ({ data: undefined }),
  useCreateClips: () => ({ mutateAsync: vi.fn(async () => []) }),
  useCreateMix: () => ({ mutateAsync: vi.fn(async () => ({ path: '/Users/me/Music/OpenStems/Song/every-stem/Mixes/Song - mix.wav' })) }),
}))

/* What the renderer shows on a Mac. Nothing here runs on one: the platform is a stand-in. */

const MAC_NOTE = recommendVariant([], { platform: 'darwin', arch: 'arm64' }).note

const setup = (patch: Partial<SetupStatus> = {}): SetupStatus => ({
  state: 'needed',
  log: [],
  managed: true,
  variant: 'mps',
  installed: null,
  variants: ['mps'],
  detected: true,
  recommended: 'mps',
  gpus: [],
  note: MAC_NOTE,
  ...patch,
})

const update = (patch: Partial<UpdateStatus>): UpdateStatus => ({ state: 'idle', current: '0.2.0', supported: true, ...patch })

function tree(children: ReactNode) {
  return (
    <TooltipProvider>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  )
}

const Row = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
  <div>
    <div>{label}</div>
    <div>{hint}</div>
    {children}
  </div>
)

beforeEach(() => {
  vi.clearAllMocks()
  bridge.info.platform = 'darwin'
})
afterEach(() => {
  bridge.info.platform = 'win32'
})

describe('the words and keys per system', () => {
  it('names things the Mac way on a Mac', () => {
    expect(isMac()).toBe(true)
    expect(words()).toMatchObject({ fileManager: 'Finder', tray: 'menu bar', trayTitle: 'Menu bar', loginItem: 'Open at login', computer: 'Mac', drive: 'disk' })
    expect(shortcut('V')).toBe('⌘V')
    expect(shortcut('Enter')).toBe('⌘Enter')
    expect(modClick()).toBe('⌘-click')
  })

  it('keeps the Windows names on Windows', () => {
    bridge.info.platform = 'win32'
    expect(isMac()).toBe(false)
    expect(words()).toMatchObject({ fileManager: 'Explorer', tray: 'tray', trayTitle: 'Tray', loginItem: 'Start with Windows', computer: 'PC', drive: 'drive' })
    expect(shortcut('V')).toBe('Ctrl+V')
    expect(modClick()).toBe('Ctrl+click')
  })

  it('takes Command on a Mac and Ctrl on Windows, never the other', () => {
    expect(modKey({ ctrlKey: false, metaKey: true })).toBe(true)
    expect(modKey({ ctrlKey: true, metaKey: false })).toBe(false)
    bridge.info.platform = 'win32'
    expect(modKey({ ctrlKey: true, metaKey: false })).toBe(true)
    expect(modKey({ ctrlKey: false, metaKey: true })).toBe(false)
  })
})

describe('the setup screen on a Mac', () => {
  it('names the one build, its size and how far it has been tried, with nothing to choose', () => {
    render(<SetupScreen status={setup()} />)
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByText('Apple Silicon · M1 and later')).toBeInTheDocument()
    expect(screen.getByText(/about 350 MB/)).toBeInTheDocument()
    expect(screen.getByText(/into your Library folder/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('has been run on one Mac so far')
    expect(document.body).not.toHaveTextContent(/NVIDIA|AMD|graphics card|this PC|user profile/)
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }))
    expect(bridge.runSetup).toHaveBeenLastCalledWith('mps')
  })

  it('falls back to the platform when the status names no builds', () => {
    render(<SetupScreen status={setup({ variants: undefined })} />)
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByText('Apple Silicon · M1 and later')).toBeInTheDocument()
  })

  it('does not mention a graphics card while it waits', () => {
    render(<SetupScreen status={setup({ detected: false, note: '' })} />)
    expect(document.body).not.toHaveTextContent(/graphics card/)
    expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled()
  })

  it('says why an Intel Mac cannot be set up, once, and offers no setup', () => {
    const reason = recommendVariant([], { platform: 'darwin', arch: 'x64' }).note
    render(<SetupScreen status={setup({ unsupported: reason, note: reason })} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/no build for Intel Macs/)
    expect(screen.getAllByText(/no build for Intel Macs/)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled()
  })

  it('still offers the three builds on Windows', () => {
    bridge.info.platform = 'win32'
    render(<SetupScreen status={setup({ variant: 'cuda', recommended: 'cuda', variants: undefined, note: 'Found NVIDIA GeForce RTX 5070 Ti.' })} />)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByText(/NVIDIA graphics cards/)).toBeInTheDocument()
    expect(screen.getByText(/into your user profile/)).toBeInTheDocument()
  })
})

describe('the System rows on a Mac', () => {
  it('names the build without a list to switch it', async () => {
    bridge.detectGpu.mockResolvedValueOnce(setup({ state: 'ready', installed: 'mps' }))
    render(tree(<EngineBuildRow />))
    expect(await screen.findByText('Engine build')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText('Apple Silicon')).toBeInTheDocument()
    expect(screen.getByText(/PyTorch for Apple Silicon \(M1 and later\)\. .*has been run on one Mac so far/)).toBeInTheDocument()
  })

  it('reads the GPU line with Metal and no empty version', () => {
    const base = { torch: '2.14.1', cuda_available: true, gpu_backend: 'mps', fake_engine: false }
    expect(gpuHint({ ...base, gpu_backend_version: 'macOS 14.5' })).toBe('PyTorch 2.14.1, Metal on macOS 14.5')
    expect(gpuHint({ ...base, gpu_backend_version: null })).toBe('PyTorch 2.14.1, Metal')
    expect(gpuHint({ ...base, cuda_available: false, gpu_backend_version: 'macOS 14.5' })).toBe('PyTorch 2.14.1, Metal on macOS 14.5. Running on the CPU.')
  })

  it('says the memory is shared, and leaves a graphics card as it was', () => {
    expect(gpuMemory({ vram_gb: 32, gpu_backend: 'mps' })).toBe('32.0 GB shared with the Mac')
    expect(gpuMemory({ vram_gb: 15.92, gpu_backend: 'cuda' })).toBe('15.9 GB')
    expect(gpuMemory({ vram_gb: null, gpu_backend: 'mps' })).toBe('')
  })

  it('carries the self-test notes after the results', () => {
    expect(selfTestLines({ ok: true, ops: [{ name: 'stft', ok: true }], notes: ['The STFT runs on the CPU.'] })).toEqual([
      'All 1 operation match the CPU.',
      'The STFT runs on the CPU.',
    ])
  })
})

describe('the menu bar settings on a Mac', () => {
  it('speaks of the menu bar and login, and leaves out what does nothing there', async () => {
    render(tree(<TraySettings />))
    const login = await screen.findByRole('switch', { name: 'Open at login' })
    expect(screen.getByRole('heading', { name: 'Menu bar' })).toBeInTheDocument()
    expect(screen.getByText('Starts in the menu bar, without opening a window.')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Keep running in the tray' })).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/Windows|tray|by the clock|right-click/)
    await act(async () => {
      fireEvent.click(login)
    })
    expect(bridge.setShell).toHaveBeenLastCalledWith({ startAtLogin: true })
  })
})

describe('an update the app cannot install itself', () => {
  const offer = update({ state: 'available', version: '0.3.0', manual: true, url: 'https://github.com/lewisgoing/OpenStems/releases/latest' })

  it('has one button that opens the download page and stays as it is', async () => {
    bridge.updates.mockResolvedValueOnce(offer)
    render(tree(<UpdatePill />))
    const pill = await screen.findByRole('button', { name: 'Get 0.3.0' })
    expect(pill).toHaveAttribute('data-state', 'available')
    fireEvent.click(pill)
    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1)
    // The main process answers with the same offer: nothing fills, nothing restarts.
    const listener = bridge.onUpdateStatus.mock.calls.at(-1)?.[0]
    act(() => listener?.(offer))
    expect(screen.getByRole('button', { name: 'Get 0.3.0' })).toBe(pill)
    expect(pill).toBeEnabled()
    expect(pill.querySelector('.update-pill-fill')).toBeNull()
    expect(bridge.installUpdate).not.toHaveBeenCalled()
  })

  it('names the version in the quick-drop window too', async () => {
    bridge.updates.mockResolvedValueOnce(offer)
    render(tree(<UpdatePill compact />))
    expect(await screen.findByRole('button', { name: 'Get 0.3.0' })).toBeInTheDocument()
  })

  it('says in Settings where the version comes from', async () => {
    expect(updateSummary(offer)).toBe('Version 0.3.0 is available. Download it from the release page.')
    bridge.updates.mockResolvedValueOnce(offer)
    render(tree(<UpdateSettings Row={Row} />))
    fireEvent.click(await screen.findByRole('button', { name: 'Open download page' }))
    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restart to update' })).not.toBeInTheDocument()
  })
})

describe('shortcuts on a Mac', () => {
  it('starts the waiting songs on Command+Enter, not on Control+Enter', () => {
    const onStart = vi.fn()
    render(tree(<StartButton held={2} onStart={onStart} />))
    expect(screen.getByRole('button', { name: /Start 2 songs/ })).toHaveAttribute('title', 'Start the songs that are waiting (⌘Enter)')
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(onStart).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("goes to the queue's search on Command+F, not on Control+F", () => {
    const field = createRef<HTMLInputElement>()
    render(tree(<QueueSearch field={field} query="" onQuery={vi.fn()} />))
    const search = screen.getByRole('textbox', { name: 'Search the queue' })
    expect(search).toHaveAttribute('title', 'Search the queue (⌘F)')
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(search).not.toHaveFocus()
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(search).toHaveFocus()
  })

  it('keeps Ctrl+F on Windows', () => {
    bridge.info.platform = 'win32'
    const field = createRef<HTMLInputElement>()
    render(tree(<QueueSearch field={field} query="" onQuery={vi.fn()} />))
    const search = screen.getByRole('textbox', { name: 'Search the queue' })
    expect(search).toHaveAttribute('title', 'Search the queue (Ctrl+F)')
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(search).not.toHaveFocus()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(search).toHaveFocus()
  })

  it('keeps Ctrl+Enter on Windows', () => {
    bridge.info.platform = 'win32'
    const onStart = vi.fn()
    render(tree(<StartButton held={1} onStart={onStart} />))
    expect(screen.getByRole('button', { name: /Start 1 song/ })).toHaveAttribute('title', 'Start the songs that are waiting (Ctrl+Enter)')
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    expect(onStart).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})

describe('undo and redo on a Mac', () => {
  it('are written with the command key, and redo with Shift', async () => {
    const { redoShortcut, shortcut } = await import('@/platform')
    bridge.info.platform = 'darwin'
    expect(shortcut('Z')).toBe('⌘Z')
    expect(redoShortcut()).toBe('⇧⌘Z')
    bridge.info.platform = 'win32'
    expect(shortcut('Z')).toBe('Ctrl+Z')
    expect(redoShortcut()).toBe('Ctrl+Y')
  })
})

describe('the trimmer on a Mac', () => {
  const DIR = '/Users/me/Music/OpenStems/Song/every-stem'
  const stem = (name: string, group: string | null = null) => ({
    name,
    file: `Song - ${name}.wav`,
    path: `${DIR}/Song - ${name}.wav`,
    peaks: null,
    samples: 44100 * 60,
    sample_rate: 44100,
    group,
    start: 0,
    empty: false,
  })
  const job = {
    id: 'j1',
    track_path: '/Users/me/Music/Song.m4a',
    track_name: 'Song',
    recipe_id: 'every-stem',
    recipe_name: 'Every stem',
    quality: 'balanced',
    state: 'done',
    progress: 1,
    message: '',
    error: null,
    cached: false,
    output_dir: DIR,
    options: {},
    stems: [stem('kick', 'drums'), stem('snare', 'drums'), stem('bass')],
    analysis: { bpm: 120, downbeat: 0.5 },
    queue_position: null,
    held: false,
    created_at: 0,
    started_at: null,
    finished_at: null,
    notes: [],
  } as Job
  const editor = (initial: TrimMemory = FRESH) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        {tree(<TrimEditor song={songOfJob(job)} initial={initial} instant={false} leaving={false} onBack={vi.fn()} onCommit={vi.fn(async () => undefined)} />)}
      </QueryClientProvider>,
    )
  const chip = (name: string) => screen.getByRole('button', { name })

  it('places freely with Option, and names Command for zooming', () => {
    expect(freeKey()).toBe('Option')
    expect(modName()).toBe('⌘')
    expect(homeKey()).toBe('Home, or Fn+←')
    bridge.info.platform = 'win32'
    expect(freeKey()).toBe('Alt')
    expect(modName()).toBe('Ctrl')
    expect(homeKey()).toBe('Home')
  })

  it('zooms with Command and the wheel, or a trackpad pinch, which arrives with Control held', () => {
    expect(isZoomWheel({ ctrlKey: false, metaKey: true }, true)).toBe(true)
    expect(isZoomWheel({ ctrlKey: true, metaKey: false }, true)).toBe(true)
    expect(isZoomWheel({ ctrlKey: false, metaKey: false }, true)).toBe(false)
    // A pinch sends small steps: each counts for more than a wheel's.
    expect(zoomFactor({ deltaY: -10, ctrlKey: true, metaKey: false }, true)).toBeCloseTo(Math.exp(0.1), 9)
    expect(zoomFactor({ deltaY: -10, ctrlKey: false, metaKey: true }, true)).toBeCloseTo(Math.exp(0.025), 9)
  })

  it('says Option and ⌘ in the editor, and a ⌘-click adds a stem where a Control-click does not', () => {
    editor()
    expect(screen.getByTestId('readout')).toHaveTextContent('Drag across the waveform')
    expect(screen.getByTestId('readout')).toHaveTextContent('Hold Option to place freely.')
    expect(screen.getByText('⌘-click to mix several stems')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Bar' })).toHaveAttribute('title', 'Snap to bars. Hold Option to place freely.')
    fireEvent.click(chip('kick'))
    fireEvent.click(chip('bass'), { metaKey: true })
    expect(chip('kick')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('bass')).toHaveAttribute('aria-pressed', 'true')
    // A Control-click is a right click on a Mac: it takes the chip alone.
    fireEvent.click(chip('snare'), { ctrlKey: true })
    expect(chip('snare')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('kick')).toHaveAttribute('aria-pressed', 'false')
    expect(TrimPlayer.last?.state.audible).toEqual(['stem:snare'])
  })

  it('leaves ⌘ with a letter to the system: ⌘L and ⌘Z do nothing in the editor', () => {
    editor({ ...FRESH, sel: { start: 2.5, end: 4.5 }, view: { t0: 10, t1: 20 } })
    const editorEl = screen.getByTestId('trim-editor')
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL', metaKey: true })
    expect(TrimPlayer.last?.state.loop).toBeNull()
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', metaKey: true })
    expect(editorEl).toHaveAttribute('data-t0', '10')
    // The letters alone are the editor's.
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL' })
    expect(TrimPlayer.last?.state.loop).toEqual({ start: 2.5, end: 4.5 })
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ' })
    expect(editorEl).toHaveAttribute('data-t0', '0')
  })
})
