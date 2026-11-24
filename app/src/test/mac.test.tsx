import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupStatus, UpdateStatus } from '../../electron/bridge'
import { recommendVariant } from '../../electron/variant'
import { SetupScreen } from '@/App'
import { ToastProvider } from '@/components/toast'
import { TooltipProvider } from '@/components/ui'
import { UpdatePill, UpdateSettings, updateSummary } from '@/components/Update'
import { isMac, modClick, modKey, shortcut, words } from '@/platform'
import { StartButton } from '@/views/QueueView'
import { EngineBuildRow, TraySettings, gpuHint, gpuMemory, selfTestLines } from '@/views/SettingsView'
import { bridge } from './setup'

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
