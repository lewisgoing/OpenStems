import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, GripVertical, Layers, Play, RotateCcw, Trash2, X, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Job, Model, Recipe } from '@/api/client'
import { keys, useJobActions, useJobs } from '@/api/queries'
import { LinkRow, useOpenLinks } from '@/components/LinkRow'
import { RecipeBar } from '@/components/RecipeBar'
import { useToast } from '@/components/toast'
import { Button, IconButton, ProgressBar, Tooltip } from '@/components/ui'
import { cn, formatPercent } from '@/lib/format'

export const ACTIVE = new Set<Job['state']>(['preparing', 'running', 'writing'])
const JOB_DRAG_TYPE = 'application/x-openstems-job'
let queueShownOnce = false

interface QueueViewProps {
  recipes: Recipe[]
  models: Model[]
  selectedJob: string | null
  onSelect: (job: Job | null) => void
  onAddFiles: (files: File[]) => void
  onPasteLink: () => void
}

export function QueueView({ recipes, models, selectedJob, onSelect, onAddFiles, onPasteLink }: QueueViewProps) {
  const { data: jobs = [] } = useJobs()
  const links = useOpenLinks()
  const actions = useJobActions()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [dragged, setDragged] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // The cascade plays once per session, the first time the queue is shown. Coming back
  // to this view, or adding a job later, shows rows without the stagger.
  const cascade = useRef(!queueShownOnce)
  useEffect(() => {
    queueShownOnce = true
    cascade.current = false
  }, [])

  const finished = jobs.filter((j) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled').length
  const held = jobs.filter((j) => j.held).length

  const drop = (targetId: string) => {
    if (!dragged || dragged === targetId) return
    const queued = jobs.filter((j) => j.state === 'queued').map((j) => j.id)
    const from = queued.indexOf(dragged)
    const to = queued.indexOf(targetId)
    if (from < 0 || to < 0) return
    queued.splice(to, 0, ...queued.splice(from, 1))
    // Move the row at once; the server confirms (or the list is refetched on error).
    queryClient.setQueryData<Job[]>(keys.jobs, (current = []) => {
      const byId = new Map(current.map((job) => [job.id, job]))
      const order = [...queued]
      return current.map((job) => (job.state === 'queued' ? (byId.get(order.shift() ?? '') ?? job) : job))
    })
    actions.reorder.mutate(queued, { onError: toast.error })
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <RecipeBar recipes={recipes} models={models} onAddFiles={onAddFiles} onPasteLink={onPasteLink} quietAdd={held > 0} />

      {jobs.length + links.length === 0 ? (
        <EmptyQueue />
      ) : (
        <>
          <div className="flex items-center justify-between px-5 pt-3 pb-1 text-muted">
            <span className="text-[12px] font-semibold tracking-wide uppercase">
              Queue <span className="tabular ml-1 font-normal text-faint">{jobs.length + links.length}</span>
            </span>
            <div className="flex items-center gap-1.5">
              <StartButton held={held} onStart={() => actions.startAll.mutate(undefined, { onError: toast.error })} />
              <Button
                size="sm"
                variant="ghost"
                disabled={finished === 0}
                onClick={() => {
                  onSelect(null)
                  actions.clearFinished.mutate(undefined, { onError: toast.error })
                }}
              >
                Clear finished
              </Button>
            </div>
          </div>
          <ul className="m-0 flex-1 list-none overflow-y-auto px-3 pt-1 pb-4" aria-label="Jobs">
            {jobs.map((job, index) => (
              <JobRow
                key={job.id}
                job={job}
                index={cascade.current ? index : 0}
                selected={job.id === selectedJob}
                dropTarget={over === job.id && dragged !== job.id}
                onSelect={() => onSelect(job.state === 'done' ? job : null)}
                onStart={() => actions.start.mutate(job.id, { onError: toast.error })}
                onCancel={() => actions.cancel.mutate(job.id, { onError: toast.error })}
                onRetry={() => actions.retry.mutate(job.id, { onError: toast.error })}
                onRemove={() => {
                  if (job.id === selectedJob) onSelect(null)
                  actions.remove.mutate(job.id, { onError: toast.error })
                }}
                onDragStart={() => setDragged(job.id)}
                onDragEnd={() => {
                  setDragged(null)
                  setOver(null)
                }}
                onDragOver={() => dragged && job.state === 'queued' && setOver(job.id)}
                onDrop={() => {
                  drop(job.id)
                  setDragged(null)
                  setOver(null)
                }}
              />
            ))}
            {/* Songs still being fetched come last: that is where their jobs will appear. */}
            {links.map((link) => (
              <LinkRow key={link.id} link={link} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * The one button of manual start: there while songs wait for it, gone when none do. It says
 * how many it starts. Ctrl+Enter does the same from the keyboard.
 */
export function StartButton({ held, onStart }: { held: number; onStart: () => void }) {
  useEffect(() => {
    if (held === 0) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !event.ctrlKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      onStart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, onStart])
  if (held === 0) return null
  return (
    <Button size="sm" variant="primary" title="Start the songs that are waiting (Ctrl+Enter)" onClick={onStart}>
      <Play size={11} fill="currentColor" />
      Start {held === 1 ? '1 song' : `${held} songs`}
    </Button>
  )
}

/** Five stem bars in a tile: the mark of an empty drop target. */
export function StemsMark() {
  return (
    <div className="mx-auto mb-5 flex h-16 w-16 items-end justify-center gap-[5px] rounded-2xl border border-line bg-surface p-4" aria-hidden="true">
      {[14, 26, 18, 30, 12].map((height, i) => (
        <span key={i} className="w-[5px] rounded-full" style={{ height, background: ['#f472b6', '#fbbf24', '#60a5fa', '#c8f04a', '#a78bfa'][i] }} />
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
  index: number
  selected: boolean
  dropTarget: boolean
  onSelect: () => void
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
  onRemove: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: () => void
  onDrop: () => void
}

function JobRow({ job, index, selected, dropTarget, onSelect, onStart, onCancel, onRetry, onRemove, onDragStart, onDragEnd, onDragOver, onDrop }: JobRowProps) {
  const active = ACTIVE.has(job.state)
  const done = job.state === 'done'
  const queued = job.state === 'queued'
  const stemPaths = job.stems.map((s) => s.path)

  return (
    <li
      data-testid="job-row"
      data-state={job.state}
      className={cn(
        'row-enter group/row row-hover relative mb-1 rounded-[10px] border border-transparent px-3 py-2.5',
        selected && '!border-line-strong bg-raised',
        done && 'cursor-pointer',
        dropTarget && 'shadow-[0_-2px_0_var(--color-accent)]',
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
    >
      <div className="flex items-center gap-2.5">
        {queued ? (
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
            <span className="truncate font-medium" title={job.track_path}>
              {job.track_name}
            </span>
            <span className="flex-none text-[12px] text-faint">
              {job.recipe_name} · {job.quality}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted" data-testid="job-status">
            {statusText(job)}
          </div>
        </div>

        {active && <span className="tabular flex-none font-mono text-[12px] text-muted">{formatPercent(job.progress)}</span>}

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
    </li>
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

export function statusText(job: Job): string {
  switch (job.state) {
    case 'queued':
      if (job.held) return 'Ready to start'
      return job.queue_position ? `Queued, ${job.queue_position} ahead` : 'Queued, up next'
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
