import { Layers, RotateCw, Search } from 'lucide-react'
import { useDeferredValue, useState } from 'react'
import type { Recipe, StemSet } from '@/api/client'
import { useStemSets } from '@/api/queries'
import { FitChip } from '@/components/Fit'
import { Button, Select, Tooltip } from '@/components/ui'
import { cn, stemColor } from '@/lib/format'

interface HistoryViewProps {
  recipes: Recipe[]
  selected: string | null
  onSelect: (set: StemSet | null) => void
  onRerun: (trackPath: string, recipeId: string) => void
}

export function HistoryView({ recipes, selected, onSelect, onRerun }: HistoryViewProps) {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const { data: sets = [], isFetched } = useStemSets(deferred)

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h1 className="m-0 font-display text-[15px] font-semibold">History</h1>
        <label className="relative ml-auto flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2.5 text-faint" />
          <input
            className="input w-[260px] pl-8"
            placeholder="Search tracks"
            aria-label="Search tracks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>

      {sets.length === 0 ? (
        <div className="grid flex-1 place-items-center p-8 text-center text-muted">
          {isFetched && (query ? `Nothing matches "${query}".` : 'Finished separations show up here, ready to drag again.')}
        </div>
      ) : (
        <ul className="m-0 flex-1 list-none overflow-y-auto px-3 py-3" aria-label="Past separations">
          {sets.map((set) => (
            <li
              key={set.directory}
              data-testid="history-row"
              className={cn(
                'group/row row-hover mb-1 flex cursor-pointer items-center gap-3 rounded-[10px] border border-transparent px-3 py-2.5',
                selected === set.directory && '!border-line-strong bg-raised',
              )}
              onClick={() => onSelect(set)}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{set.track_name}</span>
                  <span className="flex-none text-[12px] text-faint">
                    {set.recipe_name} · {formatDate(set.created_at)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1 overflow-hidden">
                  {set.stems.slice(0, 8).map((stem) => (
                    <span key={stem.name} className="chip">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: stemColor(stem.name) }} />
                      {stem.name}
                    </span>
                  ))}
                  {set.stems.length > 8 && <span className="chip">+{set.stems.length - 8}</span>}
                </div>
              </div>

              <div className="reveal-on-hover flex-none" onClick={(event) => event.stopPropagation()}>
                {set.source_exists ? (
                  <Select
                    label="Run another recipe"
                    value=""
                    options={recipes.filter((r) => !r.selectable_outputs).map((r) => ({ value: r.id, label: r.name, description: r.outputs.join(', '), trailing: <FitChip fit={r.fit} short /> }))}
                    onChange={(recipeId) => onRerun(set.track_path, recipeId)}
                    className="btn-sm"
                    minWidth={320}
                    renderValue={() => (
                      <span className="flex items-center gap-1.5">
                        <RotateCw size={12} />
                        Run another recipe
                      </span>
                    )}
                  />
                ) : (
                  <Tooltip label="The source file was moved or deleted">
                    <span className="chip">source missing</span>
                  </Tooltip>
                )}
              </div>

              <Tooltip label="Drag every stem into your DAW or a folder">
                <div
                  draggable
                  role="button"
                  tabIndex={0}
                  aria-label={`Drag all stems of ${set.track_name}`}
                  className="btn btn-sm pressable stem-handle flex-none"
                  onClick={(event) => event.stopPropagation()}
                  onDragStart={(event) => {
                    event.preventDefault()
                    window.openstems.startDrag(set.stems.map((s) => s.path))
                  }}
                >
                  <Layers size={13} />
                  {set.stems.length} stems
                </div>
              </Tooltip>
              <Button size="sm" variant="ghost" className="hidden">
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function formatDate(iso: string): string {
  const date = new Date(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
