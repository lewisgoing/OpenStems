import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppWindow, Download, FolderOpen, Layers, Play, Plus, RotateCcw, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { TrayActivity } from '../../electron/bridge'
import type { Job, Model, Recipe } from '@/api/client'
import { EngineProvider } from '@/api/engine'
import { useJobActions, useJobs, useModels, useRecipes, useSettings } from '@/api/queries'
import { useEngineStatus } from '@/api/status'
import { DropOverlay } from '@/components/DropOverlay'
import { FormatSelect } from '@/components/FormatSelect'
import { QUALITY, useCurrentRecipe, useRecipeOptions } from '@/components/RecipeBar'
import { ToastProvider, useToast } from '@/components/toast'
import { Button, IconButton, ProgressBar, Segmented, Select, Tooltip, TooltipProvider } from '@/components/ui'
import { UpdatePill } from '@/components/Update'
import { Wordmark } from '@/components/Wordmark'
import { cn, formatBytes, formatPercent, stemColor } from '@/lib/format'
import { PendingDownload, useDropFlow } from '@/state/dropflow'
import { SelectionProvider, useSelection } from '@/state/selection'
import { ACTIVE, StartButton, StateIcon, StemsMark, statusText } from '@/views/QueueView'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
})

const FINISHED = new Set<Job['state']>(['done', 'failed', 'cancelled'])
/** The window is for the last few drops; the full app has the whole queue and the history. */
const MAX_ROWS = 30
const MAX_PILLS = 12

/**
 * The quick-drop window: a small interface by the tray. Drop a song on it, then drag the
 * stems out of it. It shares the queue, the recipe and the quality with the full window.
 */
export default function TrayApp() {
  // Escape puts the window away, unless something inside it is open and takes Escape first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="listbox"], [role="dialog"]')) return
      window.openstems.hidePopup(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={450} closeDelay={0}>
        <ToastProvider>
          <div className="flex h-full flex-col">
            <header className="flex h-10 flex-none items-center gap-2 border-b border-line pr-1.5 pl-3.5">
              <Wordmark />
              <span className="flex-1" />
              <UpdatePill compact className="mr-1" />
              <IconButton label="Open the full app" onClick={() => void window.openstems.showMain()}>
                <AppWindow size={14} />
              </IconButton>
              <IconButton label="Hide" onClick={() => window.openstems.hidePopup()}>
                <X size={14} />
              </IconButton>
            </header>
            <TrayGate />
          </div>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="grid flex-1 place-items-center p-6 text-center">{children}</div>
}

function TrayGate() {
  const toast = useToast()
  const { engine, setup, connection } = useEngineStatus()

  if (setup.state !== 'ready' && setup.updating) {
    return (
      <Centered>
        <div className="flex items-center gap-3 text-muted" role="status">
          <span className="spinner" />
          Updating the audio engine
        </div>
      </Centered>
    )
  }
  if (setup.state !== 'ready') {
    return (
      <Centered>
        <div>
          <h1 className="m-0 font-display text-[15px] font-semibold">The audio engine is not set up yet</h1>
          <p className="mt-1.5 mb-4 text-muted">Setup runs once, in the full app.</p>
          <Button variant="primary" onClick={() => void window.openstems.showMain()}>
            Open the full app
          </Button>
        </div>
      </Centered>
    )
  }
  if (connection) {
    return (
      <EngineProvider connection={connection} onNotice={(message, level) => toast.show(message, { kind: level })}>
        <TrayShell />
      </EngineProvider>
    )
  }
  return (
    <Centered>
      {engine.state === 'failed' ? (
        <div>
          <h1 className="m-0 font-display text-[15px] font-semibold">The engine did not start</h1>
          <p className="mt-1.5 mb-4 max-h-[180px] overflow-y-auto whitespace-pre-line text-muted" role="alert">
            {engine.error}
          </p>
          <Button variant="primary" onClick={() => void window.openstems.restartEngine()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-muted" role="status">
          <span className="spinner" />
          {engine.state === 'starting' ? engine.detail : 'Starting'}
        </div>
      )}
    </Centered>
  )
}

function TrayShell() {
  const { data: settings } = useSettings()
  const { data: recipes } = useRecipes()
  const { data: models } = useModels()
  if (!settings || !recipes || !models) {
    return (
      <Centered>
        <span className="spinner" role="status" aria-label="Loading" />
      </Centered>
    )
  }
  return (
    <SelectionProvider settings={settings}>
      <QuickDrop recipes={recipes} models={models.models} />
    </SelectionProvider>
  )
}

/* ---- what the tray icon is told ------------------------------------------------- */

/** The queue in the three facts the tray icon shows. */
export function activityOf(jobs: Job[], finishedId: string | null): TrayActivity {
  // A song that waits for Start is not work in progress: the icon stays quiet about it.
  const open = jobs.filter((job) => !FINISHED.has(job.state) && !job.held)
  const running = open.find((job) => ACTIVE.has(job.state))
  const finished = finishedId ? jobs.find((job) => job.id === finishedId && job.state === 'done') : undefined
  return {
    active: open.length,
    current: running ? { name: running.track_name, progress: Math.round(running.progress * 100) / 100 } : null,
    done: finished ? { id: finished.id, name: finished.track_name, stems: finished.stems.length } : null,
  }
}

/**
 * The job that finished most recently while this window was alive. Jobs that were already
 * done when the list first loaded are old news and do not count.
 */
function useNewlyFinished(jobs: Job[] | undefined): string | null {
  const before = useRef<Map<string, Job['state']> | null>(null)
  const last = useRef<string | null>(null)
  // Read during render: in the render where a job first shows as done, `before` still holds
  // its earlier state, so its stems can be marked as new the moment they appear.
  if (jobs && before.current) {
    const known = before.current
    const finished = jobs.filter((job) => job.state === 'done' && known.get(job.id) !== 'done')
    const newest = finished[finished.length - 1]
    if (newest) last.current = newest.id
  }
  useEffect(() => {
    if (jobs) before.current = new Map(jobs.map((job) => [job.id, job.state]))
  }, [jobs])
  return last.current
}

/* ---- the window proper ------------------------------------------------------------ */

export function QuickDrop({ recipes, models }: { recipes: Recipe[]; models: Model[] }) {
  const { data: loaded } = useJobs()
  const jobs = loaded ?? []
  const flow = useDropFlow(recipes, models)
  const actions = useJobActions()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const finishedId = useNewlyFinished(loaded)

  // Tell the tray icon what the queue is doing. Sent only when one of the facts changes.
  const activity = JSON.stringify(activityOf(jobs, finishedId))
  useEffect(() => {
    window.openstems.reportActivity(JSON.parse(activity) as TrayActivity)
  }, [activity])

  // One finished job shows its stems: the latest, until the user picks another. A pick
  // lasts until the next job finishes, which is the one they are then waiting for.
  const [pick, setPick] = useState<{ id: string; since: string | null } | null>(null)
  const picked = pick && pick.since === finishedId ? pick.id : null
  const withStems = jobs.filter((job) => job.state === 'done' && job.stems.length > 0)
  const latest = withStems.reduce<Job | null>(
    (best, job) => (!best || (job.finished_at ?? 0) >= (best.finished_at ?? 0) ? job : best),
    null,
  )
  const expanded = picked && withStems.some((job) => job.id === picked) ? picked : (latest?.id ?? null)

  const shown = [...jobs].reverse().slice(0, MAX_ROWS)
  const finished = jobs.filter((job) => FINISHED.has(job.state)).length
  const held = jobs.filter((job) => job.held).length
  const { data: settings } = useSettings()
  const chooseFiles = () => input.current?.click()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DropTarget recipes={recipes} models={models} />

      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          if (files.length) flow.addFiles(files)
        }}
      />

      {jobs.length === 0 ? (
        <div className="m-3 mt-0 grid flex-1 place-items-center rounded-[14px] border border-dashed border-line-strong p-6 text-center">
          <div>
            <StemsMark />
            <h1 className="m-0 font-display text-[16px] font-semibold">Drop a song here</h1>
            <p className="mx-auto mt-1.5 mb-4 max-w-[250px] text-muted">
              Its stems come back to this window, ready to drag into your DAW.
            </p>
            <Button onClick={chooseFiles}>Choose files</Button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="drop-strip pressable mx-3 flex h-10 flex-none items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-strong bg-transparent text-muted"
            onClick={chooseFiles}
          >
            <Plus size={14} />
            Drop a song, or choose files
          </button>
          <div className="flex flex-none items-center justify-between pt-2 pr-2 pl-4 text-muted">
            <span className="text-[11.5px] font-semibold tracking-wide uppercase">
              Recent <span className="tabular ml-1 font-normal text-faint">{jobs.length}</span>
            </span>
            <div className="flex items-center gap-1">
              <StartButton held={held} onStart={() => actions.startAll.mutate(undefined, { onError: toast.error })} />
              <Button
                size="sm"
                variant="ghost"
                disabled={finished === 0}
                onClick={() => actions.clearFinished.mutate(undefined, { onError: toast.error })}
              >
                Clear finished
              </Button>
            </div>
          </div>
          <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto px-2 pb-2" aria-label="Recent jobs">
            {shown.map((job) => (
              <QuickRow
                key={job.id}
                job={job}
                expanded={job.id === expanded}
                fresh={picked === null && job.id === finishedId}
                onPick={() => setPick({ id: job.id, since: finishedId })}
                onStart={() => actions.start.mutate(job.id, { onError: toast.error })}
                onCancel={() => actions.cancel.mutate(job.id, { onError: toast.error })}
                onRetry={() => actions.retry.mutate(job.id, { onError: toast.error })}
              />
            ))}
          </ul>
        </>
      )}

      <DropOverlay onDrop={flow.addFiles} label={flow.label} manual={settings ? !settings.auto_start : false} />
      <PendingDownload flow={flow} models={models} />
    </div>
  )
}

/** What a drop will run: the recipe and the quality, the same choice the full window shows. */
function DropTarget({ recipes, models }: { recipes: Recipe[]; models: Model[] }) {
  const { selection, update } = useSelection()
  const { recipe, missing } = useCurrentRecipe(recipes, models)
  const options = useRecipeOptions(recipes, models)
  const noStems = Boolean(recipe?.selectable_outputs) && selection.outputs.length === 0
  return (
    <div className="flex flex-none flex-col gap-2 p-3">
      <Select
        label="Recipe"
        value={selection.target}
        options={options}
        onChange={(target) => update({ target })}
        className="w-full"
        fitTrigger
      />
      <div className="flex items-center gap-2">
        <Segmented label="Quality" value={selection.quality} options={QUALITY} onChange={(quality) => update({ quality })} className="min-w-0 flex-1" />
        <FormatSelect compact className="w-[96px] flex-none" />
      </div>
      {noStems ? (
        <p className="m-0 text-[12px] text-warn">No stems are ticked for this recipe. Pick them in the full app.</p>
      ) : (
        missing.length > 0 && (
          <p className="m-0 flex items-center gap-1.5 text-[12px] text-warn">
            <Download size={12} />
            Needs a {formatBytes(missing.reduce((sum, model) => sum + model.bytes, 0))} download. A drop asks first.
          </p>
        )
      )}
    </div>
  )
}

interface QuickRowProps {
  job: Job
  /** This job's stems are laid out for dragging. */
  expanded: boolean
  /** The stems arrived just now, so they may make an entrance. */
  fresh: boolean
  onPick: () => void
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
}

function startDrag(event: React.DragEvent, paths: string[]): void {
  // The browser's own drag carries no real file: cancel it and start a native one.
  event.preventDefault()
  window.openstems.startDrag(paths)
}

export function QuickRow({ job, expanded, fresh, onPick, onStart, onCancel, onRetry }: QuickRowProps) {
  const active = ACTIVE.has(job.state)
  const queued = job.state === 'queued'
  const done = job.state === 'done'
  const hasStems = done && job.stems.length > 0
  const pills = job.stems.slice(0, MAX_PILLS)
  const more = job.stems.length - pills.length

  return (
    <li
      data-testid="quick-row"
      data-state={job.state}
      aria-expanded={hasStems ? expanded : undefined}
      className={cn('group/row row-hover mb-0.5 rounded-[10px] px-2.5 py-2', expanded && 'bg-raised')}
      onClick={hasStems ? onPick : undefined}
    >
      <div className="flex items-center gap-2.5">
        <StateIcon job={job} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={job.track_path}>
            {job.track_name}
          </div>
          <div className="truncate text-[12px] text-muted" data-testid="quick-status">
            {done ? `${job.recipe_name} · ${job.quality}${job.cached ? ' · from the cache' : ''}` : statusText(job)}
          </div>
        </div>

        {/* One action per row, to the left of what stays put: the name keeps its room, and
            the percentage and the stems handle never move when the pointer arrives. */}
        <div className="reveal-on-hover flex flex-none items-center" onClick={(event) => event.stopPropagation()}>
          {job.held && (
            <IconButton label="Start this one" onClick={onStart}>
              <Play size={13} />
            </IconButton>
          )}
          {(active || queued) && (
            <IconButton label="Cancel" onClick={onCancel}>
              <X size={14} />
            </IconButton>
          )}
          {(job.state === 'failed' || job.state === 'cancelled') && (
            <IconButton label="Retry" onClick={onRetry}>
              <RotateCcw size={14} />
            </IconButton>
          )}
          {hasStems && (
            <IconButton label="Show in Explorer" onClick={() => void window.openstems.revealInExplorer(job.stems[0]?.path ?? '')}>
              <FolderOpen size={14} />
            </IconButton>
          )}
        </div>

        {active && <span className="tabular flex-none font-mono text-[12px] text-muted">{formatPercent(job.progress)}</span>}

        {hasStems && (
          <Tooltip label="Drag every stem into your DAW or a folder">
            <div
              draggable
              role="button"
              tabIndex={0}
              aria-label={`Drag all stems of ${job.track_name}`}
              data-testid="quick-drag-all"
              className="btn btn-sm pressable stem-handle flex-none"
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => startDrag(event, job.stems.map((stem) => stem.path))}
            >
              <Layers size={13} />
              {job.stems.length} stems
            </div>
          </Tooltip>
        )}
      </div>

      {active && (
        <div className="mt-2 ml-[24px]">
          <ProgressBar value={job.progress} indeterminate={job.state === 'preparing' && job.progress < 0.02} />
        </div>
      )}

      {hasStems && expanded && (
        <div
          className="stem-pills mt-2 ml-[24px] flex flex-wrap gap-1.5"
          data-fresh={fresh}
          aria-label={`Stems of ${job.track_name}`}
          onClick={(event) => event.stopPropagation()}
        >
          {pills.map((stem, index) => (
            <div
              key={stem.path}
              draggable
              role="button"
              tabIndex={0}
              aria-label={`Drag ${stem.name}`}
              title="Drag into your DAW or a folder"
              data-testid="quick-stem"
              className="stem-pill stem-handle"
              style={{ ['--i' as string]: Math.min(index, 8) }}
              onDragStart={(event) => startDrag(event, [stem.path])}
              onKeyDown={(event) => {
                // A drag needs a pointer. From the keyboard, Enter shows the file instead.
                if (event.key === 'Enter') void window.openstems.revealInExplorer(stem.path)
              }}
            >
              <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: stemColor(stem.name) }} />
              <span className="truncate">{stem.name}</span>
            </div>
          ))}
          {more > 0 && (
            <button type="button" className="stem-pill pressable text-muted" onClick={() => void window.openstems.showMain()}>
              +{more} in the full app
            </button>
          )}
        </div>
      )}
    </li>
  )
}
