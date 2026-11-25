import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, GripVertical, Layers, Play, RotateCcw, Scissors, Search, Trash2, X, Zap } from 'lucide-react'
import { type RefObject, useEffect, useRef, useState } from 'react'
import type { Job, Link, Model, Recipe } from '@/api/client'
import { keys, useJobActions, useJobs, useSetAnalysis, useSettings } from '@/api/queries'
import { JobNotes } from '@/components/Fit'
import { LinkRow, useOpenLinks } from '@/components/LinkRow'
import { RecipeBar } from '@/components/RecipeBar'
import { type MenuItem, RowMenu, jobMenuItems, revealHandlers } from '@/components/RowMenu'
import { SourceTitle } from '@/components/SourceTitle'
import { TempoKey } from '@/components/TempoKey'
import { useToast } from '@/components/toast'
import { Button, IconButton, ProgressBar, Select, Tooltip } from '@/components/ui'
import { cn, formatPercent, paletteColor } from '@/lib/format'
import { type QueueSort, SORTS, isQueueSort, loadSort, matchesSearch, saveSort, searchTerms, sortQueue } from '@/lib/queuesort'
import { useTheme } from '@/lib/theme'
import { tempoKeyOf } from '@/lib/tempokey'
import { modKey, shortcut } from '@/platform'
import { canTrim, jobRange } from '@/trimmer/song'

export const ACTIVE = new Set<Job['state']>(['preparing', 'running', 'writing'])

/** The queued songs in their new order, with `id` moved to `to` (clamped). Unchanged if absent. */
export function moveQueued(queued: string[], id: string, to: number): string[] {
  const from = queued.indexOf(id)
  if (from < 0) return queued
  const order = [...queued]
  order.splice(Math.max(0, Math.min(to, order.length - 1)), 0, ...order.splice(from, 1))
  return order
}
const JOB_DRAG_TYPE = 'application/x-openstems-job'
let queueShownOnce = false

interface QueueViewProps {
  recipes: Recipe[]
  models: Model[]
  selectedJob: string | null
  onSelect: (job: Job | null) => void
  onAddFiles: (files: File[]) => void
  onPasteLink: () => void
  /** Open a song in the trimmer: one waiting to start, or separated. `instant` from the keyboard. */
  onTrim?: (job: Job, instant: boolean) => void
  /** The trimmer is over the view: its keys are the trimmer's, not the queue's. */
  covered?: boolean
}

/** One row of the list: a job, or a song still being fetched from a link. */
interface QueueRow {
  id: string
  name: string
  created_at: number
  job?: Job
  link?: Link
}

export function QueueView({ recipes, models, selectedJob, onSelect, onAddFiles, onPasteLink, onTrim, covered = false }: QueueViewProps) {
  const { data: jobs = [] } = useJobs()
  const { data: settings } = useSettings()
  const separatePart = Boolean(settings?.separate_selection)
  const links = useOpenLinks()
  const actions = useJobActions()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [sort, setSort] = useState<QueueSort>(loadSort)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // The cascade plays once per session, the first time the queue is shown. Coming back
  // to this view, or adding a job later, shows rows without the stagger.
  const cascade = useRef(!queueShownOnce)
  useEffect(() => {
    queueShownOnce = true
    cascade.current = false
  }, [])

  // Rows the list has shown before. A song that is new to the queue comes in; one that a
  // search or another order brings back is simply there, since typing must not set the list
  // moving.
  const known = useRef(new Set<string>())
  useEffect(() => {
    for (const job of jobs) known.current.add(job.id)
    for (const link of links) known.current.add(link.id)
  })

  const total = jobs.length + links.length
  const terms = searchTerms(query)
  // Jobs in the order they run, then the songs still being fetched: that is where their jobs
  // will appear. Any other order places both by when they were added, or by name.
  const rows = sortQueue<QueueRow>(
    [
      ...jobs.map((job): QueueRow => ({ id: job.id, name: job.track_name, created_at: job.created_at, job })),
      ...links.map((link): QueueRow => ({ id: link.id, name: link.name, created_at: link.created_at, link })),
    ],
    sort,
  ).filter((row) => (row.job ? matchesSearch(terms, row.job.track_name, row.job.recipe_name) : matchesSearch(terms, row.name, row.link?.url)))
  // Dragging sets the order songs run in, so it is there only while the list shows that order.
  const reorderable = sort === 'run'

  const finished = jobs.filter((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled').length
  const held = jobs.filter((j) => j.held).length

  const queuedIds = jobs.filter((j) => j.state === 'queued').map((j) => j.id)
  // Put one queued song at a place among the queued ones: by drag, or from its menu.
  const moveTo = (id: string, to: number) => {
    const queued = moveQueued(queuedIds, id, to)
    if (queued.every((value, i) => value === queuedIds[i])) return
    // Move the row at once; the server confirms (or the list is refetched on error).
    queryClient.setQueryData<Job[]>(keys.jobs, (current = []) => {
      const byId = new Map(current.map((job) => [job.id, job]))
      const order = [...queued]
      return current.map((job) => (job.state === 'queued' ? (byId.get(order.shift() ?? '') ?? job) : job))
    })
    actions.reorder.mutate(queued, { onError: toast.error })
  }
  const drop = (targetId: string) => {
    if (!dragged || dragged === targetId || !queuedIds.includes(targetId)) return
    moveTo(dragged, queuedIds.indexOf(targetId))
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <RecipeBar recipes={recipes} models={models} onAddFiles={onAddFiles} onPasteLink={onPasteLink} quietAdd={held > 0} />

      {total === 0 ? (
        <EmptyQueue />
      ) : (
        <>
          <div className="@container/bar flex items-center gap-3 px-5 pt-3 pb-1 text-muted">
            <span className="flex-none text-[12px] font-semibold tracking-wide uppercase">
              Queue{' '}
              <span className="tabular ml-1 font-normal text-faint" data-testid="queue-count">
                {terms.length > 0 ? `${rows.length} of ${total}` : total}
              </span>
            </span>
            <div className="ml-auto flex min-w-0 items-center gap-1.5">
              <QueueSearch field={search} query={query} onQuery={setQuery} listen={!covered} />
              <Select
                label="Sort the queue"
                value={sort}
                options={SORTS}
                className="btn-sm flex-none"
                minWidth={250}
                onChange={(value) => {
                  if (!isQueueSort(value)) return
                  setSort(value)
                  saveSort(value)
                }}
              />
              <StartButton held={held} listen={!covered} onStart={() => actions.startAll.mutate(undefined, { onError: toast.error })} />
              <Button
                size="sm"
                variant="ghost"
                disabled={finished === 0}
                onClick={() => {
                  onSelect(null)
                  actions.clearFinished.mutate(undefined, { onError: toast.error })
                }}
              >
                <span>
                  Clear<span className="@max-[470px]/bar:sr-only"> finished</span>
                </span>
              </Button>
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="grid flex-1 place-items-center p-8 text-center text-muted" data-testid="queue-no-match">
              <div>
                <p className="m-0">Nothing in the queue matches "{query.trim()}".</p>
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setQuery('')
                    search.current?.focus()
                  }}
                >
                  Clear the search
                </Button>
              </div>
            </div>
          ) : (
          <ul className="m-0 flex-1 list-none overflow-y-auto px-3 pt-1 pb-4" aria-label="Jobs">
            {rows.map((row, index) => {
              if (row.link) return <LinkRow key={row.id} link={row.link} enter={!known.current.has(row.id)} />
              const job = row.job
              if (!job) return null
              const remove = () => {
                if (job.id === selectedJob) onSelect(null)
                actions.remove.mutate(job.id, { onError: toast.error })
              }
              const trim = onTrim && canTrim(job) ? (instant: boolean) => onTrim(job, instant) : undefined
              const menu = jobMenuItems(job, {
                start: () => actions.start.mutate(job.id, { onError: toast.error }),
                cancel: () => actions.cancel.mutate(job.id, { onError: toast.error }),
                retry: () => actions.retry.mutate(job.id, { onError: toast.error }),
                showStems: job.id === selectedJob ? undefined : () => onSelect(job),
                // Chosen from the keyboard (a click with no pointer behind it), it opens at once.
                trim: trim && ((event?: { detail?: number }) => trim(event?.detail === 0)),
                ...revealHandlers(job, (message) => toast.show(message)),
                // Only where there is somewhere to move it.
                moveTop: queuedIds.indexOf(job.id) > 0 ? () => moveTo(job.id, 0) : undefined,
                moveBottom: queuedIds.indexOf(job.id) < queuedIds.length - 1 ? () => moveTo(job.id, queuedIds.length - 1) : undefined,
                remove,
              })
              return (
              <JobRow
                key={job.id}
                job={job}
                separatePart={separatePart}
                reorderable={reorderable}
                enter={!known.current.has(job.id)}
                menu={menu}
                index={cascade.current ? index : 0}
                selected={job.id === selectedJob}
                dropTarget={over === job.id && dragged !== job.id}
                onSelect={() => onSelect(job.state === 'done' ? job : null)}
                onStart={() => actions.start.mutate(job.id, { onError: toast.error })}
                onCancel={() => actions.cancel.mutate(job.id, { onError: toast.error })}
                onRetry={() => actions.retry.mutate(job.id, { onError: toast.error })}
                onRemove={remove}
                onTrim={trim}
                onDragStart={() => setDragged(job.id)}
                onDragEnd={() => {
                  setDragged(null)
                  setOver(null)
                }}
                onDragOver={() => dragged && reorderable && job.state === 'queued' && setOver(job.id)}
                onDrop={() => {
                  drop(job.id)
                  setDragged(null)
                  setOver(null)
                }}
              />
              )
            })}
          </ul>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The queue's search field. Ctrl+F (Cmd+F on a Mac) goes to it with what is in it selected;
 * Escape empties it first and leaves it once it is empty.
 */
export function QueueSearch({
  field,
  query,
  onQuery,
  listen = true,
}: {
  field: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (query: string) => void
  listen?: boolean
}) {
  useEffect(() => {
    if (!listen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || !modKey(event) || event.altKey || event.shiftKey) return
      event.preventDefault()
      field.current?.focus()
      field.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [field, listen])
  return (
    <label className="queue-search">
      <Search size={12} className="queue-search-icon" aria-hidden="true" />
      <input
        ref={field}
        className="input"
        placeholder="Search"
        aria-label="Search the queue"
        title={`Search the queue (${shortcut('F')})`}
        spellCheck={false}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          if (query) onQuery('')
          else event.currentTarget.blur()
        }}
      />
      {query && (
        <button
          type="button"
          className="queue-search-clear press"
          aria-label="Clear the search"
          onClick={() => {
            onQuery('')
            field.current?.focus()
          }}
        >
          <X size={11} />
        </button>
      )}
    </label>
  )
}

/**
 * The one button of manual start: there while songs wait for it, gone when none do. It says
 * how many it starts. Ctrl+Enter (Cmd+Enter on a Mac) does the same from the keyboard.
 */
export function StartButton({ held, onStart, listen = true }: { held: number; onStart: () => void; listen?: boolean }) {
  useEffect(() => {
    if (held === 0 || !listen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !modKey(event) || event.altKey || event.shiftKey) return
      event.preventDefault()
      onStart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, onStart, listen])
  if (held === 0) return null
  return (
    <Button size="sm" variant="primary" title={`Start the songs that are waiting (${shortcut('Enter')})`} onClick={onStart}>
      <Play size={11} fill="currentColor" />
      Start {held === 1 ? '1 song' : `${held} songs`}
    </Button>
  )
}

/** Five stem bars in a tile: the mark of an empty drop target. */
export function StemsMark() {
  const theme = useTheme()
  return (
    <div className="mx-auto mb-5 flex h-16 w-16 items-end justify-center gap-[5px] rounded-2xl border border-line bg-surface p-4" aria-hidden="true">
      {[14, 26, 18, 30, 12].map((height, i) => (
        <span key={i} className="w-[5px] rounded-full" style={{ height, background: paletteColor(['#f472b6', '#fbbf24', '#60a5fa', '#c8f04a', '#a78bfa'][i] ?? '#c8f04a', theme) }} />
      ))}
    </div>
  )
}

function EmptyQueue() {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-[360px] text-center">
        <StemsMark />
        <h2 className="m-0 font-display text-[17px] font-semibold">Drop audio or video here</h2>
        <p className="mt-2 mb-0 text-muted">
          Files and folders work anywhere in this window, and so does a pasted link to a song. Stems land in your
          output folder, ready to drag into your DAW.
        </p>
      </div>
    </div>
  )
}

interface JobRowProps {
  job: Job
  /** The separate_selection setting: a waiting song's part is all that Start separates. */
  separatePart: boolean
  /** The list shows the order songs run in, so a waiting song can be dragged to another place. */
  reorderable: boolean
  /** New to the queue, so it comes in. Read once, when the row first appears. */
  enter: boolean
  /** What a right-click on the row offers. */
  menu: MenuItem[]
  index: number
  selected: boolean
  dropTarget: boolean
  onSelect: () => void
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
  onRemove: () => void
  /** Open it in the trimmer; absent when it cannot be trimmed (yet). */
  onTrim?: (instant: boolean) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: () => void
  onDrop: () => void
}

function JobRow({ job, separatePart, reorderable, enter, menu, index, selected, dropTarget, onSelect, onStart, onCancel, onRetry, onRemove, onTrim, onDragStart, onDragEnd, onDragOver, onDrop }: JobRowProps) {
  const active = ACTIVE.has(job.state)
  const done = job.state === 'done'
  const queued = job.state === 'queued'
  const stemPaths = job.stems.map((s) => s.path)
  // The tempo and key the user gave this song ahead of its run, if any.
  const given = tempoKeyOf(job.options)
  const setAnalysis = useSetAnalysis()
  const toast = useToast()
  const [entering] = useState(enter)

  return (
    <RowMenu
      items={menu}
      label={`${job.track_name} actions`}
      render={
        <li
          data-testid="job-row"
          data-state={job.state}
          className={cn(
            'group/row row-hover relative mb-1 rounded-[10px] border border-transparent px-3 py-2.5',
            entering && 'row-enter',
            selected && '!border-line-strong bg-raised',
            done && 'cursor-pointer',
            dropTarget && 'shadow-[0_-2px_0_var(--color-accent-fg)]',
          )}
          style={{ ['--stagger' as string]: `${Math.min(index, 6) * 30}ms` }}
          onClick={onSelect}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(JOB_DRAG_TYPE)) return
            event.preventDefault()
            onDragOver()
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes(JOB_DRAG_TYPE)) return
            event.preventDefault()
            onDrop()
          }}
        />
      }
    >
      {/* A container: narrow (the stems panel open in a small window), Trim keeps its icon only
          and the recipe gives way before the song's name does. */}
      <div className="@container/row flex items-center gap-2.5">
        {queued && reorderable ? (
          <div
            draggable
            role="button"
            tabIndex={0}
            aria-label={`Reorder ${job.track_name}`}
            className="stem-handle -ml-1 grid h-6 w-4 flex-none place-items-center text-faint"
            onDragStart={(event) => {
              event.dataTransfer.setData(JOB_DRAG_TYPE, job.id)
              event.dataTransfer.effectAllowed = 'move'
              onDragStart()
            }}
            onDragEnd={onDragEnd}
            onClick={(event) => event.stopPropagation()}
          >
            <GripVertical size={13} />
          </div>
        ) : (
          <StateIcon job={job} />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <SourceTitle name={job.track_name} source={job.track_path} className="min-w-0 font-medium" />
            <span className="min-w-0 shrink-[4] truncate text-[12px] text-faint">
              {job.recipe_name} · {job.quality}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted" data-testid="job-status">
            {statusText(job, separatePart)}
          </div>
          <JobNotes notes={job.notes} className="mt-0.5" />
        </div>

        {active && <span className="tabular flex-none font-mono text-[12px] text-muted">{formatPercent(job.progress)}</span>}

        {queued && (
          <TempoKey
            bpm={given.bpm}
            keyName={given.key}
            empty="auto"
            hint="Leave it empty to have it detected."
            onChange={(change) => setAnalysis.job.mutateAsync({ id: job.id, ...change })}
            onError={toast.error}
          />
        )}

        {onTrim && (
          <Tooltip label={done ? 'Cut a part out of the song or its stems' : 'Cut a part out of the song before it is separated'}>
            <Button
              size="sm"
              // Narrower still, a waiting row's tempo and key fields need the room: its Trim is
              // in the row's menu.
              className={cn('flex-none', queued && '@max-[400px]/row:hidden')}
              aria-label={`Trim ${job.track_name}`}
              data-testid="row-trim"
              data-trim-song={job.id}
              onClick={(event) => {
                // The row opens the stems panel on a click; this button opens the trimmer instead.
                event.stopPropagation()
                onTrim(event.detail === 0)
              }}
            >
              <Scissors size={13} />
              <span className="@max-[480px]/row:sr-only">Trim</span>
            </Button>
          </Tooltip>
        )}

        {done && job.stems.length > 0 && (
          <Tooltip label="Drag every stem into your DAW or a folder">
            <div
              draggable
              role="button"
              tabIndex={0}
              aria-label={`Drag all stems of ${job.track_name}`}
              className="btn btn-sm pressable stem-handle flex-none"
              onClick={(event) => event.stopPropagation()}
              onDragStart={(event) => {
                event.preventDefault()
                window.openstems.startDrag(stemPaths)
              }}
            >
              <Layers size={13} />
              {job.stems.length} stems
            </div>
          </Tooltip>
        )}

        <div className="reveal-on-hover flex flex-none items-center" onClick={(event) => event.stopPropagation()}>
          {(active || queued) && (
            <IconButton label="Cancel" onClick={onCancel}>
              <X size={14} />
            </IconButton>
          )}
          {job.held && (
            <IconButton label="Start this one" onClick={onStart}>
              <Play size={13} />
            </IconButton>
          )}
          {(job.state === 'failed' || job.state === 'cancelled') && (
            <IconButton label="Retry" onClick={onRetry}>
              <RotateCcw size={14} />
            </IconButton>
          )}
          {!active && !queued && (
            <IconButton label="Remove from the list" onClick={onRemove}>
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
      </div>

      {active && (
        <div className="mt-2 ml-[26px]">
          <ProgressBar value={job.progress} indeterminate={job.state === 'preparing' && job.progress < 0.02} />
        </div>
      )}
    </RowMenu>
  )
}

export function StateIcon({ job }: { job: Job }) {
  if (ACTIVE.has(job.state)) return <span className="spinner flex-none" aria-hidden="true" />
  if (job.state === 'done') {
    return (
      <span className="grid h-3.5 w-3.5 flex-none place-items-center rounded-full bg-ok/20 text-ok" aria-hidden="true">
        {job.cached ? <Zap size={9} fill="currentColor" /> : <Check size={10} strokeWidth={3} />}
      </span>
    )
  }
  if (job.state === 'failed') return <AlertTriangle size={14} className="flex-none text-danger" aria-hidden="true" />
  return <span className="h-3.5 w-3.5 flex-none rounded-full border border-line-strong" aria-hidden="true" />
}

/**
 * What a row says about a song. `separatePart` is the separate_selection setting: with it on, a
 * waiting song with a part chosen in the trimmer says that Start separates only that part.
 */
export function statusText(job: Job, separatePart = false): string {
  switch (job.state) {
    case 'queued': {
      const waiting = job.held ? 'Ready to start' : job.queue_position ? `Queued, ${job.queue_position} ahead` : 'Queued, up next'
      const part = separatePart ? jobRange(job) : null
      return part ? `${waiting}, ${part.label} only` : waiting
    }
    case 'preparing':
    case 'running':
    case 'writing':
      return job.message || 'Working'
    case 'done':
      return job.cached ? 'Done, from the cache' : 'Done'
    case 'failed':
      return job.error ?? 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}
