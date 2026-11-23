import type { Model, Recipe, SystemInfo } from '@/api/client'
import { words } from '@/platform'

/**
 * What the app says about memory: what a model needs, what this machine has for one, and
 * what happens when the two do not match. The engine decides the fit; this file only words
 * it. Nothing here blocks a run. The engine always tries the GPU first, whatever the fit
 * says, and moves a model to the CPU only when memory really runs out: the sentences say
 * what may happen, not what will.
 */

export type Fit = 'fits' | 'tight' | 'no'

/** The machine as the engine sees it for one model run. */
export interface Machine {
  /** GB for one model run. Null when the engine does not know: everything then fits. */
  budget: number | null
  /** The memory the budget is cut from. */
  total: number | null
  /** A graphics card with its own VRAM, an Apple GPU that shares the Mac's memory, or the CPU. */
  kind: 'card' | 'shared' | 'cpu'
  /** OPENSTEMS_MEMORY_GB stands in for the detected memory. */
  overridden: boolean
}

type SystemFacts = Pick<
  SystemInfo,
  'cuda_available' | 'gpu_backend' | 'memory_budget_gb' | 'memory_gb' | 'memory_kind' | 'memory_overridden'
>

const KINDS = { cuda: 'card', mps: 'shared', cpu: 'cpu' } as const

/**
 * The engine says where models run (`memory_kind`), and the budget beside it follows the
 * same rule: it knows the settings and what the environment overrides. `useGpu` is only for
 * an engine that does not say.
 */
export function machineOf(system: Partial<SystemFacts> | undefined, useGpu = true): Machine {
  const gpu = Boolean(system?.cuda_available) && useGpu
  const guessed = !gpu ? 'cpu' : system?.gpu_backend === 'mps' ? 'shared' : 'card'
  return {
    budget: system?.memory_budget_gb ?? null,
    total: system?.memory_gb ?? null,
    kind: system?.memory_kind ? KINDS[system.memory_kind] : guessed,
    overridden: Boolean(system?.memory_overridden),
  }
}

/** "VRAM" where the machine has a graphics card, "memory" on a Mac and on the CPU. */
export function memoryWord(machine: Machine): string {
  return machine.kind === 'card' ? 'VRAM' : 'memory'
}

export function formatGb(gb: number): string {
  return `${gb.toFixed(1)} GB`
}

/** "needs about 3.8 GB", or nothing when the engine gave no figure. */
export function needsText(item: { memory_gb?: number }): string | null {
  return item.memory_gb ? `needs about ${formatGb(item.memory_gb)}` : null
}

/** "This Mac has about 4.5 GB of memory for a model." */
export function budgetSentence(machine: Machine): string {
  if (machine.budget === null) return ''
  return `This ${words().computer} has about ${formatGb(machine.budget)} of ${memoryWord(machine)} for a model.`
}

/** What may happen when a model that is tight or too large is run. */
export function outcomeSentence(fit: Fit, machine: Machine): string {
  if (machine.kind === 'cpu') {
    return fit === 'no' ? 'It may run out of memory.' : 'It should fit, with little to spare.'
  }
  return fit === 'no'
    ? 'It may not fit. If it does not, it runs on the CPU, which is much slower.'
    : 'It should fit. If it does not, it runs on the CPU, which is much slower.'
}

/** The short mark: nothing when it fits. */
export function fitLabel(fit: Fit | undefined, short = false): string | null {
  if (fit === 'tight') return 'tight fit'
  if (fit === 'no') return short ? 'too large' : `too large for this ${words().computer}`
  return null
}

/** The sentence beside a model that is tight or does not fit. Nothing when it fits. */
export function modelFitNote(model: Pick<Model, 'fit'>, machine: Machine): string | null {
  if (!model.fit || model.fit === 'fits') return null
  return `${budgetSentence(machine)} ${outcomeSentence(model.fit, machine)}`.trim()
}

/**
 * The same for a recipe, naming the model that decides it: models run one at a time, so a
 * recipe is as large as its largest model. When another recipe for the same job fits, it is
 * named as the way around.
 */
export function recipeFitNote(recipe: Recipe, models: Model[], machine: Machine, recipes: Recipe[] = []): string | null {
  if (!recipe.fit || recipe.fit === 'fits') return null
  const model = models.find((m) => m.id === recipe.fit_model)
  const need = needsText(recipe)
  const subject = model && need ? `${model.name} ${need}. ` : ''
  const other = recipe.fit === 'no' ? fittingRecipe(recipe, recipes) : undefined
  const way = other ? ` ${other.name} fits.` : ''
  return `${subject}${budgetSentence(machine)} ${outcomeSentence(recipe.fit, machine)}${way}`.trim()
}

const RANK: Record<Fit, number> = { fits: 0, tight: 1, no: 2 }

/**
 * A recipe to suggest in place of one that does not fit: the first that does, from the same
 * use case when there is one. Experimental recipes and those with stems to tick are never a
 * suggestion. Undefined when nothing better exists.
 */
export function fittingRecipe(recipe: Recipe, recipes: Recipe[]): Recipe | undefined {
  const candidates = recipes.filter((r) => r.id !== recipe.id && !r.experimental && !r.selectable_outputs && (r.fit ?? 'fits') !== 'no')
  const best = (list: Recipe[]) => [...list].sort((a, b) => RANK[a.fit ?? 'fits'] - RANK[b.fit ?? 'fits'])[0]
  return best(candidates.filter((r) => r.use_case === recipe.use_case)) ?? best(candidates)
}

/** The recipe a fresh install starts on: the default, unless it does not fit and another does. */
export function suggestedRecipe(defaultId: string, recipes: Recipe[]): string {
  const recipe = recipes.find((r) => r.id === defaultId)
  if (!recipe || recipe.fit !== 'no') return defaultId
  return fittingRecipe(recipe, recipes)?.id ?? defaultId
}

/**
 * The set offered for the first download: what the engine recommends for this machine. An
 * engine that marks nothing (an older one) leaves the usual set.
 */
export function recommendedModels(models: Model[]): Model[] {
  const chosen = models.filter((m) => m.recommended)
  return chosen.length > 0 ? chosen : models.filter((m) => m.seed)
}

/** Why the recommended set is not the usual one, or nothing when it is. */
export function recommendedReason(models: Model[], machine: Machine): string | null {
  const chosen = recommendedModels(models)
  const left = models.filter((m) => m.seed && !chosen.includes(m))
  const added = chosen.filter((m) => !m.seed)
  if (left.length === 0 && added.length === 0) return null
  const computer = words().computer
  const list = (items: Model[]) => items.map((m) => m.name).join(', ')
  const parts = [`This set is chosen for this ${computer}'s ${memoryWord(machine)}.`]
  if (left.length > 0) {
    parts.push(`${list(left)} ${left.length === 1 ? 'needs' : 'need'} more than it has for a model and ${left.length === 1 ? 'is' : 'are'} left out.`)
  }
  if (added.length > 0) parts.push(`${list(added)} ${added.length === 1 ? 'takes' : 'take'} ${left.length > 0 ? 'the place' : 'part'}.`)
  return parts.join(' ')
}

/** The Settings row: where the budget comes from, and whether it is overridden. */
export function budgetHint(machine: Machine): string {
  const computer = words().computer
  const memory = `this ${computer}'s ${machine.total ? `${formatGb(machine.total)} of ` : ''}memory`
  const larger = 'A model that does not fit in it runs on the CPU, which is much slower.'
  const source =
    machine.kind === 'card'
      ? `The graphics card's VRAM. ${larger}`
      : machine.kind === 'shared'
        ? `A share of ${memory}, which the GPU shares with the system and other apps. ${larger}`
        : `Half of ${memory}, since separation runs on the CPU.`
  return machine.overridden ? `${source} OPENSTEMS_MEMORY_GB is set: it stands in for the memory that was detected.` : source
}
