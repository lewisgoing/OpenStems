import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existingAncestor, spaceOf } from '../../electron/space'
import type { Model, Settings } from '@/api/client'
import { stemBytes } from '@/components/FormatSelect'
import { ToastProvider } from '@/components/toast'
import { TooltipProvider } from '@/components/ui'
import { WELCOME_KEY, Welcome, modelsFit, shouldWelcome } from '@/components/Welcome'
import { bridge } from './setup'

/* The welcome: the first start with the engine ready. Folders, format, models. */

const GB = 1024 ** 3
let settings: Settings
const patch = { mutate: vi.fn() }
const pull = { mutate: vi.fn() }

vi.mock('@/api/queries', () => ({
  useSettings: () => ({ data: settings }),
  usePatchSettings: () => patch,
  useModelActions: () => ({ pull }),
  useSystem: () => ({ data: undefined }),
}))

const model = (patch: Partial<Model>): Model =>
  ({
    id: 'bs-roformer-sw',
    name: 'BS-RoFormer SW',
    bytes: 2 * GB,
    status: 'missing',
    stems: ['vocals'],
    license: 'MIT',
    seed: true,
    recommended: true,
    experimental: false,
    custom: false,
    used_by: [],
    download: null,
    fit: 'fits',
    memory_gb: 3.8,
    memory_estimated: false,
    ...patch,
  }) as Model

function tree(children: ReactNode) {
  return (
    <TooltipProvider>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  )
}

const missing = [model({}), model({ id: 'mel', name: 'Mel-RoFormer', bytes: 1 * GB })]

beforeEach(() => {
  vi.clearAllMocks()
  settings = {
    output_dir: 'D:\\OpenStems',
    models_dir: 'D:\\models',
    output_format: 'wav32f',
    auto_start: false,
    tempo_sync: false,
  } as Settings
})
afterEach(() => {
  bridge.info.platform = 'win32'
  bridge.info.welcome = undefined
})

describe('when the welcome shows', () => {
  const storage = (entries: Record<string, string>) => ({ getItem: (key: string) => entries[key] ?? null })

  it('shows on a first start, with no models yet', () => {
    expect(shouldWelcome(missing, storage({}))).toBe(true)
  })

  it('stays away from an install that has models, or has seen it or the model offer before it', () => {
    expect(shouldWelcome([model({ status: 'installed' })], storage({}))).toBe(false)
    expect(shouldWelcome([model({ download: { state: 'downloading' } as Model['download'] })], storage({}))).toBe(false)
    expect(shouldWelcome(missing, storage({ [WELCOME_KEY]: 'seen' }))).toBe(false)
    expect(shouldWelcome(missing, storage({ 'openstems.seed-offer.v1': 'seen' }))).toBe(false)
  })

  it('can be forced for the end-to-end test, where the FakeEngine has every model', () => {
    expect(shouldWelcome([model({ status: 'installed' })], storage({ [WELCOME_KEY]: 'seen' }), true)).toBe(true)
  })

  it('is remembered once closed, early or not', () => {
    render(tree(<Welcome models={missing} onDownloaded={vi.fn()} />))
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(localStorage.getItem(WELCOME_KEY)).toBe('seen')
  })
})

describe('the folders step', () => {
  it('shows both folders with the free space on their drive', async () => {
    render(tree(<Welcome models={missing} onDownloaded={vi.fn()} />))
    expect(screen.getByRole('heading', { name: 'Where should your files go?' })).toBeInTheDocument()
    const stems = await screen.findByTestId('welcome-folder-stems')
    expect(stems).toHaveTextContent('D:\\OpenStems')
    expect(await within(stems).findByTestId('free-space')).toHaveTextContent('120 GB free')
    expect(screen.getByTestId('welcome-folder-models')).toHaveTextContent('The recommended models take 3.0 GB.')
    expect(bridge.folderSpace).toHaveBeenCalledWith('D:\\models')
  })

  it('saves a folder picked with Change, and leaves it alone when the picker is closed', async () => {
    render(tree(<Welcome models={missing} onDownloaded={vi.fn()} />))
    bridge.pickFolder.mockResolvedValueOnce('E:\\Stems')
    await act(async () => fireEvent.click(within(screen.getByTestId('welcome-folder-stems')).getByRole('button', { name: 'Change' })))
    expect(bridge.pickFolder).toHaveBeenCalledWith('D:\\OpenStems')
    expect(patch.mutate).toHaveBeenNthCalledWith(1, { output_dir: 'E:\\Stems' }, expect.anything())
    await act(async () => fireEvent.click(within(screen.getByTestId('welcome-folder-models')).getByRole('button', { name: 'Change' })))
    expect(patch.mutate).toHaveBeenCalledTimes(1)
  })

  it('warns when the models will not fit on the drive, in the words of each system', async () => {
    bridge.folderSpace.mockResolvedValue({ free: 2 * GB, total: 256 * GB })
    render(tree(<Welcome models={missing} onDownloaded={vi.fn()} />))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough room on this drive for the recommended models.')
    bridge.folderSpace.mockResolvedValue({ free: 120 * GB, total: 1000 * GB })
  })

  it('says disk on a Mac', async () => {
    bridge.info.platform = 'darwin'
    bridge.folderSpace.mockResolvedValue({ free: 2 * GB, total: 256 * GB })
    render(tree(<Welcome models={missing} onDownloaded={vi.fn()} />))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough room on this disk')
    bridge.folderSpace.mockResolvedValue({ free: 120 * GB, total: 1000 * GB })
  })

  it('leaves room to spare, and says nothing when the size or the space is not known', () => {
    expect(modelsFit({ free: 3.5 * GB, total: 0 }, 3 * GB)).toBe(false)
    expect(modelsFit({ free: 4.5 * GB, total: 0 }, 3 * GB)).toBe(true)
    expect(modelsFit(null, 3 * GB)).toBe(true)
    expect(modelsFit({ free: 0, total: 0 }, 0)).toBe(true)
  })
})

describe('the format step', () => {
  const toFormat = () => {
    render(tree(<Welcome models={missing} onDownloaded={vi.fn()} />))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  }

  it('offers the four formats with their size, the chosen one checked', () => {
    toFormat()
    const radios = within(screen.getByRole('radiogroup', { name: 'Output format' })).getAllByRole('radio')
    expect(radios).toHaveLength(4)
    expect(screen.getByRole('radio', { name: /WAV 32-bit float/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /WAV 32-bit float/ }).closest('label')).toHaveTextContent('≈ 81 MB')
    expect(screen.getByRole('radio', { name: /MP3 320 kbps/ }).closest('label')).toHaveTextContent('≈ 9 MB')
  })

  it('saves the format and the two switches as they change', () => {
    toFormat()
    fireEvent.click(screen.getByRole('radio', { name: /FLAC/ }))
    expect(patch.mutate).toHaveBeenNthCalledWith(1, { output_format: 'flac' }, expect.anything())
    fireEvent.click(screen.getByRole('switch', { name: 'Start songs as soon as they are added' }))
    expect(patch.mutate).toHaveBeenNthCalledWith(2, { auto_start: true }, expect.anything())
    fireEvent.click(screen.getByRole('switch', { name: 'Tempo-sync for FL Studio' }))
    expect(patch.mutate).toHaveBeenNthCalledWith(3, { tempo_sync: true }, expect.anything())
  })

  it('marks the formats FL Studio reads no tempo from while tempo sync is on', () => {
    settings = { ...settings, tempo_sync: true }
    toFormat()
    expect(screen.getByRole('radio', { name: /MP3/ }).closest('label')).toHaveTextContent('FL Studio reads no tempo from it')
    expect(screen.getByRole('radio', { name: /WAV 24-bit/ }).closest('label')).not.toHaveTextContent('reads no tempo')
  })

  it('comes back to the folders with Back', () => {
    toFormat()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { name: 'Where should your files go?' })).toBeInTheDocument()
  })

  it('moves a step by pointer, and shows one reached from the keyboard at once', () => {
    render(tree(<Welcome models={missing} onDownloaded={vi.fn()} />))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }), { detail: 1 })
    expect(document.querySelector('.welcome-body')).toHaveAttribute('data-animate', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }), { detail: 0 })
    expect(document.querySelector('.welcome-body')).toHaveAttribute('data-animate', 'false')
    expect(document.querySelector('.welcome-body')).toHaveAttribute('data-dir', '-1')
  })
})

describe('the models step', () => {
  const toModels = (models: Model[]) => {
    const onDownloaded = vi.fn()
    render(tree(<Welcome models={models} onDownloaded={onDownloaded} />))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    return onDownloaded
  }

  it('downloads the recommended models and goes to them', () => {
    const onDownloaded = toModels(missing)
    expect(screen.getByRole('dialog')).toHaveTextContent('2 models, 3.0 GB in total.')
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(pull.mutate.mock.calls.map((call) => call[0])).toEqual(['bs-roformer-sw', 'mel'])
    expect(onDownloaded).toHaveBeenCalled()
    expect(localStorage.getItem(WELCOME_KEY)).toBe('seen')
  })

  it('downloads nothing with Not now', () => {
    const onDownloaded = toModels(missing)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(pull.mutate).not.toHaveBeenCalled()
    expect(onDownloaded).not.toHaveBeenCalled()
  })

  it('leaves out what the models folder already holds', () => {
    bridge.info.welcome = true
    toModels([...missing, model({ id: 'held', name: 'Held', status: 'installed' })])
    expect(screen.getByRole('dialog')).toHaveTextContent('2 models, 3.0 GB in total.')
    expect(screen.queryByText('Held')).not.toBeInTheDocument()
  })

  it('says so when the models folder already holds them', () => {
    bridge.info.welcome = true
    toModels([model({ status: 'installed' })])
    expect(screen.getByRole('heading', { name: 'You are ready' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(localStorage.getItem(WELCOME_KEY)).toBe('seen')
  })
})

describe('the sizes and the free space', () => {
  it('gives one stem of a four-minute song in each format', () => {
    expect(Math.round(stemBytes('wav32f', 240) / 1024 ** 2)).toBe(81)
    expect(Math.round(stemBytes('wav24', 240) / 1024 ** 2)).toBe(61)
    expect(stemBytes('flac', 240)).toBeLessThan(stemBytes('wav24', 240))
    expect(stemBytes('mp3', 240)).toBe(240 * 40_000)
  })

  it('finds the nearest folder that exists, on Windows and on a Mac', () => {
    const win = new Set(['D:\\', 'D:\\Music'])
    const winParent = (p: string) => (p.length <= 3 ? p : p.slice(0, p.lastIndexOf('\\')) || p.slice(0, 3))
    expect(existingAncestor('D:\\Music\\OpenStems\\new', (p) => win.has(p), winParent)).toBe('D:\\Music')
    const mac = new Set(['/', '/Users/me'])
    const macParent = (p: string) => (p === '/' ? '/' : p.slice(0, p.lastIndexOf('/')) || '/')
    expect(existingAncestor('/Users/me/Music/OpenStems', (p) => mac.has(p), macParent)).toBe('/Users/me')
    expect(existingAncestor('/Volumes/Gone/x', () => false, macParent)).toBeNull()
  })

  it('reads statfs as bytes, in numbers or bigints', () => {
    expect(spaceOf({ bavail: 10, blocks: 100, bsize: 4096 })).toEqual({ free: 40960, total: 409600 })
    expect(spaceOf({ bavail: 10n, blocks: 100n, bsize: 4096n })).toEqual({ free: 40960, total: 409600 })
  })
})
