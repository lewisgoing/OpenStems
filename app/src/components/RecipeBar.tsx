import { Checkbox } from '@base-ui/react/checkbox'
import { Popover } from '@base-ui/react/popover'
import { Check, Download, Link2, Plus, SlidersHorizontal } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { Model, Recipe } from '@/api/client'
import { formatBytes, stemColor } from '@/lib/format'
import { type Fit, modelFitNote, recipeFitNote } from '@/lib/memory'
import { shortcut } from '@/platform'
import { useMachine } from '@/state/machine'
import { MODEL_PREFIX, useSelection } from '@/state/selection'
import { FitChip } from './Fit'
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
  /** Take the link on the clipboard. Ctrl+V (Cmd+V on a Mac) does the same. */
  onPasteLink: () => void
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

/**
 * Whether what is selected fits this machine, with the sentence that says what will happen.
 * A recipe is as large as its largest model, and the sentence names it.
 */
export function useCurrentFit(recipes: Recipe[], models: Model[]): { fit: Fit; note: string | null } {
  const machine = useMachine()
  const { recipe, model } = useCurrentRecipe(recipes, models)
  return useMemo(() => {
    if (model) return { fit: model.fit ?? 'fits', note: modelFitNote(model, machine) }
    if (recipe) return { fit: recipe.fit ?? 'fits', note: recipeFitNote(recipe, models, machine, recipes) }
    return { fit: 'fits' as const, note: null }
  }, [recipe, model, models, recipes, machine])
}

/**
 * What a recipe writes, in as few chips as say it: a stem on its own by its name, the
 * parts of a larger stem as that stem with how many parts it has (drums 7).
 */
export function outputChips(outputs: string[], groups: Record<string, string> = {}): { name: string; parts: number }[] {
  const chips: { name: string; parts: number }[] = []
  for (const stem of outputs) {
    const group = groups[stem]
    const last = chips[chips.length - 1]
    if (group && last?.name === group) last.parts += 1
    else chips.push({ name: group ?? stem, parts: 1 })
  }
  return chips
}

/** The same in a line of words, for the recipe list. */
function outputsLine(recipe: Recipe): string {
  const groups = recipe.output_groups ?? {}
  if (Object.keys(groups).length === 0) return recipe.outputs.join(', ')
  const chips = outputChips(recipe.outputs, groups).map((chip) => (chip.parts > 1 ? `${chip.name} (${chip.parts})` : chip.name))
  return `${recipe.outputs.length} stems: ${chips.join(', ')}`
}

/** What an option shows at its right end: a mark when it does not fit, and a download it needs. */
function trailing(fit: Fit | undefined, note: string | null, download: number | null) {
  if (download === null && (!fit || fit === 'fits')) return undefined
  return (
    <span className="flex flex-none items-center gap-1">
      <FitChip fit={fit} note={note} short />
      {download !== null && (
        <span className="chip flex-none">
          <Download size={10} />
          {formatBytes(download)}
        </span>
      )}
    </span>
  )
}

/** Every recipe and every single model as options for the recipe select, grouped. */
export function useRecipeOptions(recipes: Recipe[], models: Model[]): SelectOption[] {
  const machine = useMachine()
  return useMemo<SelectOption[]>(() => {
    const recipeOptions = recipes.map((r) => ({
      value: r.id,
      label: r.name,
      description: r.selectable_outputs ? r.description : outputsLine(r),
      group: r.experimental ? 'Experimental' : r.use_case || 'Recipes',
      trailing: trailing(r.fit, recipeFitNote(r, models, machine), r.missing_models.length > 0 ? r.download_bytes : null),
    }))
    const modelOptions = models.map((m) => ({
      value: MODEL_PREFIX + m.id,
      label: m.name,
      description: m.stems.length > 8 ? `${m.stems.length} stems` : m.stems.join(', '),
      group: 'Single model',
      trailing: trailing(m.fit, modelFitNote(m, machine), m.status !== 'installed' ? m.bytes : null),
    }))
    // Keep groups together in the order recipes arrive, experimental ones last.
    const standard = recipeOptions.filter((o) => o.group !== 'Experimental')
    const experimental = recipeOptions.filter((o) => o.group === 'Experimental')
    return [...standard, ...experimental, ...modelOptions]
  }, [recipes, models, machine])
}

export function RecipeBar({ recipes, models, onAddFiles, onPasteLink, quietAdd }: RecipeBarProps) {
  const { selection, update } = useSelection()
  const { recipe, stems, missing } = useCurrentRecipe(recipes, models)
  const input = useRef<HTMLInputElement>(null)
  const options = useRecipeOptions(recipes, models)
  const { fit, note } = useCurrentFit(recipes, models)

  const shownStems = recipe?.selectable_outputs ? selection.outputs : stems
  const shownChips = outputChips(shownStems, recipe?.output_groups)

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
        {shownChips.slice(0, 8).map((chip) => (
          <span key={chip.name} className="chip">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: stemColor(chip.name) }} />
            {chip.name}
            {chip.parts > 1 && <span className="tabular text-faint">{chip.parts}</span>}
          </span>
        ))}
        {shownChips.length > 8 && <span className="chip">+{shownChips.length - 8}</span>}
      </div>
      {/* Tight or too large for this machine. It is advice: Add files works all the same. */}
      {note && (
        <Tooltip label={note}>
          <FitChip fit={fit} data-testid="recipe-fit" />
        </Tooltip>
      )}
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
      {/* One accent action: adding files. A link is the second way in, so it stays quiet. */}
      <Tooltip label={`Fetch the song behind a copied link: YouTube, SoundCloud, Bandcamp and more (${shortcut('V')})`}>
        <Button className="flex-none" onClick={onPasteLink}>
          <Link2 size={14} />
          Paste link
        </Button>
      </Tooltip>
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
