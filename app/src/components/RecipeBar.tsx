import { Checkbox } from '@base-ui/react/checkbox'
import { Popover } from '@base-ui/react/popover'
import { Check, Download, Plus, SlidersHorizontal } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { Model, Recipe } from '@/api/client'
import { formatBytes, stemColor } from '@/lib/format'
import { MODEL_PREFIX, useSelection } from '@/state/selection'
import { FormatSelect } from './FormatSelect'
import { Button, Segmented, Select, type SelectOption, Switch, Tooltip } from './ui'

export const QUALITY = [
  { value: 'fast' as const, label: 'Fast', hint: 'One pass. About 15x real time for a full song.' },
  { value: 'balanced' as const, label: 'Balanced', hint: 'Twice the overlap. Smoother chunk seams.' },
  { value: 'best' as const, label: 'Best', hint: 'Overlap 8 plus test-time augmentation. About 12x slower than Fast.' },
]

interface RecipeBarProps {
  recipes: Recipe[]
  models: Model[]
  onAddFiles: (files: File[]) => void
  /** Songs are waiting for Start: that is the main action now, so "Add files" steps back. */
  quietAdd?: boolean
}

export function useCurrentRecipe(recipes: Recipe[], models: Model[]) {
  const { selection } = useSelection()
  return useMemo(() => {
    if (selection.target.startsWith(MODEL_PREFIX)) {
      const model = models.find((m) => m.id === selection.target.slice(MODEL_PREFIX.length))
      return { recipe: undefined, model, stems: model?.stems ?? [], missing: model && model.status !== 'installed' ? [model] : [] }
    }
    const recipe = recipes.find((r) => r.id === selection.target) ?? recipes[0]
    const missing = (recipe?.missing_models ?? []).flatMap((id) => models.find((m) => m.id === id) ?? [])
    return { recipe, model: undefined, stems: recipe?.outputs ?? [], missing }
  }, [selection.target, recipes, models])
}

/** Every recipe and every single model as options for the recipe select, grouped. */
export function useRecipeOptions(recipes: Recipe[], models: Model[]): SelectOption[] {
  return useMemo<SelectOption[]>(() => {
    const recipeOptions = recipes.map((r) => ({
      value: r.id,
      label: r.name,
      description: r.selectable_outputs ? r.description : r.outputs.join(', '),
      group: r.experimental ? 'Experimental' : r.use_case || 'Recipes',
      trailing: r.missing_models.length > 0 ? (
        <span className="chip flex-none">
          <Download size={10} />
          {formatBytes(r.download_bytes)}
        </span>
      ) : undefined,
    }))
    const modelOptions = models.map((m) => ({
      value: MODEL_PREFIX + m.id,
      label: m.name,
      description: m.stems.length > 8 ? `${m.stems.length} stems` : m.stems.join(', '),
      group: 'Single model',
      trailing: m.status !== 'installed' ? (
        <span className="chip flex-none">
          <Download size={10} />
          {formatBytes(m.bytes)}
        </span>
      ) : undefined,
    }))
    // Keep groups together in the order recipes arrive, experimental ones last.
    const standard = recipeOptions.filter((o) => o.group !== 'Experimental')
    const experimental = recipeOptions.filter((o) => o.group === 'Experimental')
    return [...standard, ...experimental, ...modelOptions]
  }, [recipes, models])
}

export function RecipeBar({ recipes, models, onAddFiles, quietAdd }: RecipeBarProps) {
  const { selection, update } = useSelection()
  const { recipe, stems, missing } = useCurrentRecipe(recipes, models)
  const input = useRef<HTMLInputElement>(null)
  const options = useRecipeOptions(recipes, models)

  const shownStems = recipe?.selectable_outputs ? selection.outputs : stems

  return (
    <div className="@container flex items-start gap-3 border-b border-line px-5 py-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
      <Select
        label="Recipe"
        value={selection.target}
        options={options}
        onChange={(target) => update({ target })}
        className="min-w-[190px] flex-none"
        minWidth={380}
      />
      <Segmented label="Quality" value={selection.quality} options={QUALITY} onChange={(quality) => update({ quality })} />
      <FormatSelect compact className="flex-none" />

      {recipe?.selectable_outputs && (
        <StemPicker all={recipe.outputs} selected={selection.outputs} onChange={(outputs) => update({ outputs })} />
      )}

      {recipe?.supports_sum_to_mix && (
        <Tooltip label="Fold what the stems miss into 'other', so they sum back to the mix">
          <label className="flex flex-none items-center gap-2 whitespace-nowrap text-muted">
            <Switch label="Sum to mix" checked={selection.sumToMix} onChange={(sumToMix) => update({ sumToMix })} />
            Sum to mix
          </label>
        </Tooltip>
      )}

      <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-hidden @[900px]:flex" aria-label="Stems this will write">
        {shownStems.slice(0, 8).map((stem) => (
          <span key={stem} className="chip">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: stemColor(stem) }} />
            {stem}
          </span>
        ))}
        {shownStems.length > 8 && <span className="chip">+{shownStems.length - 8}</span>}
      </div>
      {missing.length > 0 && (
        <span className="chip flex-none !border-warn/40 !text-warn">
          <Download size={10} />
          needs {formatBytes(missing.reduce((sum, m) => sum + m.bytes, 0))}
        </span>
      )}
      </div>

      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length) onAddFiles(files)
        }}
      />
      <Button variant={quietAdd ? 'default' : 'primary'} className="flex-none" onClick={() => input.current?.click()}>
        <Plus size={14} />
        Add files
      </Button>
    </div>
  )
}

function StemPicker({ all, selected, onChange }: { all: string[]; selected: string[]; onChange: (stems: string[]) => void }) {
  const [filter, setFilter] = useState('')
  const shown = all.filter((s) => s.includes(filter.trim().toLowerCase()))
  const toggle = (stem: string, on: boolean) =>
    onChange(on ? [...selected, stem].sort((a, b) => all.indexOf(a) - all.indexOf(b)) : selected.filter((s) => s !== stem))
  return (
    <Popover.Root>
      <Popover.Trigger className="btn pressable">
        <SlidersHorizontal size={13} />
        {selected.length === 0 ? 'Pick stems' : `${selected.length} stems`}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start" className="z-50">
          <Popover.Popup className="popup w-[260px] p-2">
            <input
              className="input mb-2 w-full"
              placeholder="Filter stems"
              aria-label="Filter stems"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <div className="max-h-[300px] overflow-y-auto">
              {shown.map((stem) => (
                <label key={stem} className="menu-item">
                  <Checkbox.Root
                    checked={selected.includes(stem)}
                    onCheckedChange={(on) => toggle(stem, on)}
                    className="grid h-4 w-4 flex-none place-items-center rounded-[4px] border border-line-strong data-[checked]:border-accent data-[checked]:bg-accent"
                  >
                    <Checkbox.Indicator className="text-accent-ink">
                      <Check size={11} strokeWidth={3} />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  {stem}
                </label>
              ))}
              {shown.length === 0 && <p className="m-0 px-2 py-3 text-muted">No stem matches.</p>}
            </div>
            <div className="mt-2 flex justify-between border-t border-line pt-2">
              <Button size="sm" variant="ghost" onClick={() => onChange([])}>
                Clear
              </Button>
              <span className="self-center text-[12px] text-faint">Only ticked stems are computed</span>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
