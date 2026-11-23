import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Model, Recipe, SystemInfo } from '@/api/client'
import { SeedOffer } from '@/App'
import { ToastProvider } from '@/components/toast'
import { TooltipProvider } from '@/components/ui'
import {
  type Machine,
  budgetHint,
  fitLabel,
  fittingRecipe,
  machineOf,
  modelFitNote,
  needsText,
  recipeFitNote,
  recommendedModels,
  recommendedReason,
  suggestedRecipe,
} from '@/lib/memory'
import { SelectionProvider, useSelection } from '@/state/selection'
import { ModelsView } from '@/views/ModelsView'
import { MemoryRow } from '@/views/SettingsView'
import { bridge } from './setup'

/* Lower memory: what a model needs, what the machine has, and what the app says about it. */

let models: Model[] = []
let system: Partial<SystemInfo> | undefined
const modelActions = {
  pull: { mutate: vi.fn() },
  cancel: { mutate: vi.fn() },
  verify: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  importModel: { mutate: vi.fn(), isPending: false },
}

vi.mock('@/api/queries', () => ({
  useModels: () => ({ data: { models, models_dir: 'D:\\models', installed_bytes: 0 } }),
  useModelActions: () => modelActions,
  useSystem: () => ({ data: system }),
  useSettings: () => ({ data: { use_gpu: true } }),
}))

const model = (patch: Partial<Model>): Model =>
  ({
    id: 'bs-roformer-sw',
    name: 'BS-RoFormer SW',
    bytes: 1_368_919_887,
    status: 'missing',
    stems: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
    license: 'MIT',
    seed: false,
    recommended: false,
    experimental: false,
    custom: false,
    used_by: [],
    download: null,
    fit: 'fits',
    memory_gb: 3.8,
    memory_estimated: false,
    ...patch,
  }) as Model

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
    supports_sum_to_mix: true,
    fit: 'fits',
    fit_model: 'bs-roformer-sw',
    memory_gb: 3.8,
    ...patch,
  }) as Recipe

/** A PC with a 6 GB card, an 8 GB Mac, and a PC with no usable GPU. */
const CARD: Machine = { budget: 6, total: 6, kind: 'card', overridden: false }
const MAC: Machine = { budget: 4.5, total: 8, kind: 'shared', overridden: false }
const CPU: Machine = { budget: 8, total: 16, kind: 'cpu', overridden: false }

const cardSystem: Partial<SystemInfo> = { cuda_available: true, gpu_backend: 'cuda', memory_budget_gb: 6, memory_gb: 6, memory_overridden: false }
const macSystem: Partial<SystemInfo> = { cuda_available: true, gpu_backend: 'mps', memory_budget_gb: 4.5, memory_gb: 8, memory_overridden: false }

function tree(children: ReactNode) {
  return (
    <TooltipProvider>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  models = []
  system = undefined
  bridge.info.platform = 'win32'
})
afterEach(() => {
  bridge.info.platform = 'win32'
})

describe('the machine', () => {
  it('is a card with VRAM, an Apple GPU with shared memory, or the CPU', () => {
    expect(machineOf(cardSystem)).toEqual(CARD)
    expect(machineOf(macSystem)).toEqual(MAC)
    expect(machineOf({ cuda_available: false, gpu_backend: null, memory_budget_gb: 8, memory_gb: 16 })).toEqual(CPU)
  })

  it('is the CPU when the GPU is switched off, and knows nothing before the engine answers', () => {
    expect(machineOf(cardSystem, false).kind).toBe('cpu')
    expect(machineOf(undefined)).toEqual({ budget: null, total: null, kind: 'cpu', overridden: false })
    expect(machineOf({ ...macSystem, memory_overridden: true }).overridden).toBe(true)
  })

  it('takes where models run from the engine, which knows the settings and the environment', () => {
    // The GPU works, but the engine was told to stay on the CPU: its budget is the CPU's.
    expect(machineOf({ ...cardSystem, memory_kind: 'cpu', memory_budget_gb: 15.6, memory_gb: 31.2 })).toEqual({
      budget: 15.6,
      total: 31.2,
      kind: 'cpu',
      overridden: false,
    })
    // A setting this window has not caught up with does not relabel the engine's figures.
    expect(machineOf({ ...cardSystem, memory_kind: 'cuda' }, false).kind).toBe('card')
    expect(machineOf({ ...macSystem, memory_kind: 'mps' }).kind).toBe('shared')
  })
})

describe('the words for a fit', () => {
  it('says nothing when the model fits', () => {
    expect(fitLabel('fits')).toBeNull()
    expect(fitLabel(undefined)).toBeNull()
    expect(modelFitNote(model({ fit: 'fits' }), CARD)).toBeNull()
    expect(recipeFitNote(recipe({ fit: 'fits' }), [], CARD)).toBeNull()
  })

  it('says what a model needs, or nothing without a figure', () => {
    expect(needsText(model({ memory_gb: 3.84 }))).toBe('needs about 3.8 GB')
    expect(needsText(model({ memory_gb: 0 }))).toBeNull()
  })

  it('speaks of VRAM and this PC on Windows with a graphics card', () => {
    expect(fitLabel('no')).toBe('too large for this PC')
    expect(fitLabel('tight')).toBe('tight fit')
    expect(modelFitNote(model({ fit: 'no' }), CARD)).toBe(
      'This PC has about 6.0 GB of VRAM for a model. It may not fit. If it does not, it runs on the CPU, which is much slower.',
    )
    expect(modelFitNote(model({ fit: 'tight' }), CARD)).toBe(
      'This PC has about 6.0 GB of VRAM for a model. It should fit. If it does not, it runs on the CPU, which is much slower.',
    )
  })

  it('speaks of memory and this Mac on a Mac', () => {
    bridge.info.platform = 'darwin'
    expect(fitLabel('no')).toBe('too large for this Mac')
    expect(fitLabel('no', true)).toBe('too large')
    expect(modelFitNote(model({ fit: 'no' }), MAC)).toBe(
      'This Mac has about 4.5 GB of memory for a model. It may not fit. If it does not, it runs on the CPU, which is much slower.',
    )
    expect(modelFitNote(model({ fit: 'tight' }), MAC)).toBe(
      'This Mac has about 4.5 GB of memory for a model. It should fit. If it does not, it runs on the CPU, which is much slower.',
    )
  })

  it('promises no CPU to fall back on when the CPU is already what runs', () => {
    expect(modelFitNote(model({ fit: 'no' }), CPU)).toBe('This PC has about 8.0 GB of memory for a model. It may run out of memory.')
    expect(modelFitNote(model({ fit: 'tight' }), CPU)).toBe('This PC has about 8.0 GB of memory for a model. It should fit, with little to spare.')
  })

  it('names the model that decides a recipe, and a recipe that fits instead', () => {
    const leap = model({ id: 'leap', name: 'BS-RoFormer Leap Xe' })
    const best = recipe({ id: 'best', name: 'Full song, best vocals', fit: 'no', fit_model: 'leap', memory_gb: 7.2 })
    const plain = recipe({})
    expect(recipeFitNote(best, [leap], CARD, [best, plain])).toBe(
      'BS-RoFormer Leap Xe needs about 7.2 GB. This PC has about 6.0 GB of VRAM for a model. It may not fit. If it does not, it runs on the CPU, which is much slower. Full song fits.',
    )
    // A tight recipe is not sent elsewhere, and a recipe with nothing better says only what happens.
    expect(recipeFitNote({ ...best, fit: 'tight' }, [leap], CARD, [best, plain])).not.toMatch(/Full song fits/)
    expect(recipeFitNote(best, [leap], CARD, [best])).toMatch(/much slower\.$/)
  })
})

describe('the recipe that is suggested', () => {
  const best = recipe({ id: 'best', name: 'Best vocals', use_case: 'Vocals', fit: 'no' })
  const vocals = recipe({ id: 'vocals', name: 'Vocals', use_case: 'Vocals', fit: 'tight' })
  const full = recipe({ id: 'full-song', fit: 'fits' })
  const mega = recipe({ id: 'mega', selectable_outputs: true })
  const lab = recipe({ id: 'lab', experimental: true })

  it('is the default when it fits or is only tight', () => {
    expect(suggestedRecipe('full-song', [best, full])).toBe('full-song')
    expect(suggestedRecipe('vocals', [vocals, full])).toBe('vocals')
    expect(suggestedRecipe('gone', [full])).toBe('gone')
  })

  it('is one that fits when the default does not: the same use case first, then the best fit', () => {
    expect(fittingRecipe(best, [best, vocals, full])?.id).toBe('vocals')
    expect(suggestedRecipe('best', [best, full, vocals])).toBe('vocals')
    expect(suggestedRecipe('best', [best, recipe({ id: 'a', fit: 'tight' }), full])).toBe('full-song')
  })

  it('stays the default when nothing fits, and never an experimental recipe or one with stems to tick', () => {
    expect(suggestedRecipe('best', [best, mega, lab, recipe({ id: 'b', fit: 'no' })])).toBe('best')
  })

  it('is where a fresh selection starts, and never replaces what the user chose', () => {
    const Target = () => <span data-testid="target">{useSelection().selection.target}</span>
    const settings = { default_recipe: 'best', default_quality: 'balanced', sum_to_mix: false } as Parameters<typeof SelectionProvider>[0]['settings']
    const { unmount } = render(
      <SelectionProvider settings={settings} recipes={[best, full]}>
        <Target />
      </SelectionProvider>,
    )
    expect(screen.getByTestId('target')).toHaveTextContent('full-song')
    unmount()
    localStorage.setItem('openstems.selection.v1', JSON.stringify({ target: 'best' }))
    render(
      <SelectionProvider settings={settings} recipes={[best, full]}>
        <Target />
      </SelectionProvider>,
    )
    expect(screen.getByTestId('target')).toHaveTextContent('best')
  })
})

describe('the recommended set', () => {
  const sw = model({ id: 'sw', name: 'BS-RoFormer SW', seed: true, recommended: true })
  const leap = model({ id: 'leap', name: 'Leap Xe', seed: true, recommended: false, fit: 'no' })
  const small = model({ id: 'small', name: 'Mel-Band vocals', seed: false, recommended: true })

  it('is what the engine recommends, and the usual set when it marks nothing', () => {
    expect(recommendedModels([sw, leap, small]).map((m) => m.id)).toEqual(['sw', 'small'])
    expect(recommendedModels([{ ...sw, recommended: false }, leap]).map((m) => m.id)).toEqual(['sw', 'leap'])
  })

  it('gives no reason when it is the usual set', () => {
    expect(recommendedReason([sw, { ...leap, recommended: true }], CARD)).toBeNull()
  })

  it('says which models are left out and which take their place, per system', () => {
    expect(recommendedReason([sw, leap, small], CARD)).toBe(
      "This set is chosen for this PC's VRAM. Leap Xe needs more than it has for a model and is left out. Mel-Band vocals takes the place.",
    )
    bridge.info.platform = 'darwin'
    expect(recommendedReason([sw, leap], MAC)).toBe(
      "This set is chosen for this Mac's memory. Leap Xe needs more than it has for a model and is left out.",
    )
  })

  it('is what the first-run offer downloads, with the reason', () => {
    models = [sw, leap, small]
    system = macSystem
    bridge.info.platform = 'darwin'
    render(tree(<SeedOffer models={models} onStarted={vi.fn()} />))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent("2 models, 2.5 GB in total. This set is chosen for this Mac's memory.")
    expect(within(dialog).queryByText('Leap Xe')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }))
    expect(modelActions.pull.mutate.mock.calls.map((call) => call[0])).toEqual(['sw', 'small'])
  })

  it('offers the usual set, in the usual words, where everything fits', () => {
    models = [sw, { ...leap, recommended: true, fit: 'fits' }]
    system = { ...cardSystem, memory_budget_gb: 15.9 }
    render(tree(<SeedOffer models={models} onStarted={vi.fn()} />))
    expect(screen.getByRole('dialog')).toHaveTextContent('They cover every standard recipe')
    expect(screen.getByRole('dialog')).not.toHaveTextContent('This set is chosen')
  })
})

describe('the Models view', () => {
  const row = (name: string) => screen.getByText(name).closest('[data-testid="model-row"]') as HTMLElement

  it('says what each model needs, and nothing more when it fits', () => {
    models = [model({ seed: true, recommended: true })]
    system = { ...cardSystem, memory_budget_gb: 15.9 }
    render(tree(<ModelsView />))
    expect(row('BS-RoFormer SW')).toHaveTextContent('1.3 GB · needs about 3.8 GB · license: MIT')
    expect(screen.queryByTestId('fit-chip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fit-note')).not.toBeInTheDocument()
    expect(screen.queryByTestId('budget-note')).not.toBeInTheDocument()
    expect(within(row('BS-RoFormer SW')).getByText('recommended')).toBeInTheDocument()
  })

  it('marks a tight model quietly, with what will happen', () => {
    models = [model({ fit: 'tight', memory_gb: 5.4 })]
    system = cardSystem
    render(tree(<ModelsView />))
    const chip = within(row('BS-RoFormer SW')).getByTestId('fit-chip')
    expect(chip).toHaveTextContent('tight fit')
    expect(chip.className).not.toMatch(/warn|danger/)
    expect(within(row('BS-RoFormer SW')).getByTestId('fit-note')).toHaveTextContent(
      'It should fit. If it does not, it runs on the CPU, which is much slower.',
    )
    expect(screen.getByTestId('budget-note')).toHaveTextContent('This PC has about 6.0 GB of VRAM for a model.')
  })

  it('marks a model that is too large, and still lets it be downloaded', () => {
    models = [model({ fit: 'no', memory_gb: 7.2 })]
    system = cardSystem
    render(tree(<ModelsView />))
    expect(within(row('BS-RoFormer SW')).getByTestId('fit-chip')).toHaveTextContent('too large for this PC')
    expect(within(row('BS-RoFormer SW')).getByTestId('fit-note')).toHaveTextContent('It may not fit. If it does not, it runs on the CPU, which is much slower.')
    expect(screen.getByTestId('budget-note')).toHaveTextContent('This PC has about 6.0 GB of VRAM for a model.')
    fireEvent.click(within(row('BS-RoFormer SW')).getByRole('button', { name: /1\.3 GB/ }))
    expect(modelActions.pull.mutate).toHaveBeenCalledWith('bs-roformer-sw', expect.anything())
  })

  it('words it for a Mac, and recommends what the engine recommends there', () => {
    bridge.info.platform = 'darwin'
    models = [
      model({ id: 'leap', name: 'Leap Xe', fit: 'no', seed: true, recommended: false }),
      model({ id: 'small', name: 'Mel-Band vocals', seed: false, recommended: true }),
    ]
    system = macSystem
    render(tree(<ModelsView />))
    expect(within(row('Leap Xe')).getByTestId('fit-chip')).toHaveTextContent('too large for this Mac')
    expect(within(row('Leap Xe')).getByTestId('fit-note')).toHaveTextContent('It may not fit. If it does not, it runs on the CPU, which is much slower.')
    expect(screen.getByTestId('budget-note')).toHaveTextContent(
      'This Mac has about 4.5 GB of memory for a model. Models run one at a time. A model that is marked can still be used.',
    )
    expect(within(row('Leap Xe')).queryByText('recommended')).not.toBeInTheDocument()
    expect(within(row('Mel-Band vocals')).getByText('recommended')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Download recommended/ }))
    expect(modelActions.pull.mutate.mock.calls.map((call) => call[0])).toEqual(['small'])
  })
})

describe('the memory row in Settings', () => {
  it('shows the budget and where it comes from, per kind of machine', () => {
    const { rerender } = render(<MemoryRow machine={CARD} />)
    expect(screen.getByTestId('memory-budget')).toHaveTextContent('6.0 GB')
    expect(screen.getByText(/The graphics card's VRAM\. A model that does not fit in it runs on the CPU/)).toBeInTheDocument()
    bridge.info.platform = 'darwin'
    rerender(<MemoryRow machine={MAC} />)
    expect(screen.getByTestId('memory-budget')).toHaveTextContent('4.5 GB')
    expect(screen.getByText(/A share of this Mac's 8\.0 GB of memory, which the GPU shares with the system and other apps/)).toBeInTheDocument()
    bridge.info.platform = 'win32'
    expect(budgetHint(CPU)).toBe("Half of this PC's 16.0 GB of memory, since separation runs on the CPU.")
  })

  it('says when OPENSTEMS_MEMORY_GB stands in for the real memory', () => {
    render(<MemoryRow machine={{ ...MAC, overridden: true }} />)
    expect(screen.getByTestId('memory-budget')).toHaveTextContent('4.5 GB')
    expect(screen.getByText(/OPENSTEMS_MEMORY_GB is set: it stands in for the memory that was detected\./)).toBeInTheDocument()
  })

  it('is absent when the engine gives no budget', () => {
    const { container } = render(<MemoryRow machine={machineOf(undefined)} />)
    expect(container).toBeEmptyDOMElement()
  })
})
