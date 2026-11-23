import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { JobOptions, Quality, Recipe, Settings } from '@/api/client'
import type { NewJobs } from '@/api/queries'

/** What dropped files will run: a recipe or a single model, plus quality and options. */
export interface Selection {
  /** A recipe id, or `model:<model id>` for a single-model run. */
  target: string
  quality: Quality
  sumToMix: boolean
  /** Ticked stems for recipes whose outputs are selectable (mega-53). */
  outputs: string[]
}

interface SelectionApi {
  selection: Selection
  update: (patch: Partial<Selection>) => void
}

const STORAGE_KEY = 'openstems.selection.v1'
const SelectionContext = createContext<SelectionApi | null>(null)

export function useSelection(): SelectionApi {
  const api = useContext(SelectionContext)
  if (!api) throw new Error('useSelection must be used inside <SelectionProvider>')
  return api
}

function load(settings: Settings): Selection {
  const fallback: Selection = {
    target: settings.default_recipe,
    quality: settings.default_quality,
    sumToMix: settings.sum_to_mix,
    outputs: [],
  }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Selection> | null
    return stored ? { ...fallback, ...stored } : fallback
  } catch {
    return fallback
  }
}

export function SelectionProvider({ settings, children }: { settings: Settings; children: ReactNode }) {
  const [selection, setSelection] = useState<Selection>(() => load(settings))
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection))
  }, [selection])
  // The other window changed the selection: follow it. Storage events only reach the
  // windows that did not make the change, and writing the same value back raises none.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return
      try {
        const stored = JSON.parse(event.newValue) as Partial<Selection>
        setSelection((current) => ({ ...current, ...stored }))
      } catch {
        // Not ours.
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const update = useCallback((patch: Partial<Selection>) => setSelection((s) => ({ ...s, ...patch })), [])
  const value = useMemo(() => ({ selection, update }), [selection, update])
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export const MODEL_PREFIX = 'model:'

/** Build the job request for a set of files from the current selection. */
export function toJobRequest(selection: Selection, recipe: Recipe | undefined, paths: string[]): NewJobs {
  const options: JobOptions = {}
  if (recipe?.supports_sum_to_mix) options.sum_to_mix = selection.sumToMix
  if (recipe?.selectable_outputs) options.outputs = selection.outputs
  if (selection.target.startsWith(MODEL_PREFIX)) {
    return { paths, model: selection.target.slice(MODEL_PREFIX.length), quality: selection.quality, options }
  }
  return { paths, recipe: selection.target, quality: selection.quality, options }
}
