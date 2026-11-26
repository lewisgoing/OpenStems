import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppWindow, Blend, Download, FolderOpen, Layers, Link2, Pause, Play, Plus, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TrayActivity } from '../../electron/bridge'
import { type Job, type Link, type Model, type Recipe, type StemFile, fileUrl } from '@/api/client'
import { EngineProvider, useEngine } from '@/api/engine'
import { useJobActions, useJobs, useModels, useRecipes, useSettings } from '@/api/queries'
import { useEngineStatus } from '@/api/status'
import { Audition, type AuditionState } from '@/audio/audition'
import { StemPlayer } from '@/audio/player'
import { DropOverlay } from '@/components/DropOverlay'
import { JobNotes } from '@/components/Fit'
import { FormatSelect } from '@/components/FormatSelect'
import { LinkRow, useOpenLinks } from '@/components/LinkRow'
import { type MenuItem, RowMenu, jobMenuItems, revealHandlers } from '@/components/RowMenu'
import { QUALITY, useCurrentFit, useCurrentRecipe, useRecipeOptions } from '@/components/RecipeBar'
import { SourceTitle } from '@/components/SourceTitle'
import { ToastProvider, useToast } from '@/components/toast'
import { Button, IconButton, ProgressBar, Segmented, Select, Tooltip, TooltipProvider } from '@/components/ui'
import { UpdatePill } from '@/components/Update'
import { Wordmark } from '@/components/Wordmark'
import { dragAllHint, leftOutWord, splitEmpty, stemCount } from '@/lib/empty'
import { cn, formatBytes, formatPercent, stemColor } from '@/lib/format'
import { isMac, shortcut, words } from '@/platform'
import { PendingDownload, useDropFlow, usePaste } from '@/state/dropflow'
import { type MixFile, capitalize, groupsOf, mixLabel, useMixFile } from '@/state/mix'
import { SelectionProvider, useSelection } from '@/state/selection'
import { ACTIVE, StartButton, StateIcon, StemsMark, statusText } from '@/views/QueueView'
import { useTheme } from '@/lib/theme'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
})

const FINISHED = new Set<Job['state']>(['done', 'failed', 'cancelled'])
/** The window is for the last few drops; the full app has the whole queue and the history. */
const MAX_ROWS = 30
const MAX_PILLS = 12

/**
 * How many stem pills a row shows. A "+N in the full app" pill takes the room of a stem
 * pill at least, so hiding a single stem behind it saves nothing: one over the limit shows
 * them all (every-stem's 13). Past that the rest go to the full app, so a 53-stem split does
 * not fill the window.
 */
export function pillCount(stems: number): number {
  return stems <= MAX_PILLS + 1 ? stems : MAX_PILLS
}

/**
 * The quick-drop window: a small interface by the tray (on a Mac, under the menu bar). Drop a song on it, then drag the
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

  const mac = isMac()
  const hide = (
    <IconButton label="Hide" onClick={() => window.openstems.hidePopup()}>
      <X size={14} />
    </IconButton>
  )
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={450} closeDelay={0}>
        <ToastProvider>
          <div className="flex h-full flex-col">
            {/* The button that puts the window away sits where each system keeps its close
                button: at the right on Windows, at the left on a Mac. */}
            <header className={cn('flex h-10 flex-none items-center gap-2 border-b border-line pr-1.5', mac ? 'pl-1.5' : 'pl-3.5')}>
              {mac && hide}
              <Wordmark />
              <span className="flex-1" />
              <UpdatePill compact className="mr-1" />
              <IconButton label="Open the full app" onClick={() => void window.openstems.showMain()}>
                <AppWindow size={14} />
              </IconButton>
              {!mac && hide}
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
    <SelectionProvider settings={settings} recipes={recipes}>
      <QuickDrop recipes={recipes} models={models.models} />
    </SelectionProvider>
  )
}

/* ---- what the tray icon is told ------------------------------------------------- */

/** The queue in the three facts the tray icon shows. */
export function activityOf(jobs: Job[], finishedId: string | null, links: Link[] = []): TrayActivity {
  // A song that waits for Start is not work in progress: the icon stays quiet about it.
  const open = jobs.filter((job) => !FINISHED.has(job.state) && !job.held)
  const running = open.find((job) => ACTIVE.has(job.state))
  const finished = finishedId ? jobs.find((job) => job.id === finishedId && job.state === 'done') : undefined
  // A song being fetched from a link is work in progress; a fetch that failed is not.
  const fetching = links.filter((link) => link.state !== 'failed').length
  return {
    active: open.length + fetching,
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

/* ---- listening before dragging ---------------------------------------------------- */

/**
 * One stem at a time, by clicking its pill. It stops when the window is put away and when
 * the song it belongs to is no longer the one laid out.
 */
function useAudition(shown: StemFile[]): {
  state: AuditionState
  listen: (stem: StemFile, group: string) => void
  stop: () => void
} {
  const { connection } = useEngine()
  const audition = useMemo(
    () => new Audition({ Authorization: `Bearer ${connection.token}` }, window.openstems.info.e2e),
    [connection.token],
  )
  const state = useSyncExternalStore(
    (listener) => audition.subscribe(listener),
    () => audition.state,
  )
  useEffect(() => () => audition.dispose(), [audition])
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) audition.stop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [audition])
  const paths = shown.map((stem) => stem.path).join('|')
  useEffect(() => {
    if (audition.state.path && !paths.split('|').includes(audition.state.path)) audition.stop()
  }, [audition, paths])
  const toast = useToast()
  const error = state.error
  useEffect(() => {
    if (error) toast.show(error, { kind: 'error' })
  }, [error, toast])
  const stop = useCallback(() => audition.stop(), [audition])
  return {
    state,
    listen: (stem, group) => void audition.toggle({ path: stem.path, url: fileUrl(connection, stem.path), group }),
    stop,
  }
}

/* ---- a mix of the stems ----------------------------------------------------------- */

export interface Mixer {
  /** The stems left out of the mix. */
  off: string[]
  playing: boolean
  /** Stems are being fetched and decoded for playback: how many of how many. */
  loading: { loaded: number; total: number } | null
  /** The mix as one file, for dragging out. */
  file: MixFile
  toggleStem: (name: string) => void
  playPause: () => void
}

/**
 * The laid-out song's stems as a mix: every stem is in until it is clicked out. What is in
 * can be heard together, in sync, and dragged out as one file.
 */
function useMixer(job: Job | undefined, onEnter: () => void): { mixer: Mixer | null; toggle: () => void } {
  const { connection } = useEngine()
  const toast = useToast()
  const [mix, setMix] = useState<{ id: string; off: string[] } | null>(null)
  const jobId = job?.id ?? ''
  const off = job && mix?.id === job.id ? mix.off : null
  const mixing = off !== null
  const stems = useMemo(() => job?.stems ?? [], [job?.stems])

  const player = useMemo(
    () => new StemPlayer({ Authorization: `Bearer ${connection.token}` }, window.openstems.info.e2e),
    [connection.token],
  )
  const state = useSyncExternalStore(
    (listener) => player.subscribe(listener),
    () => player.state,
  )
  useEffect(() => () => player.dispose(), [player])
  // Leaving the mix, or laying out another song, lets go of the decoded stems.
  useEffect(() => {
    if (!mixing) return
    return () => player.dispose()
  }, [player, mixing, jobId])
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) player.pause()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [player])
  const error = state.status === 'error' ? state.error : undefined
  useEffect(() => {
    if (error) toast.show(error, { kind: 'error' })
  }, [error, toast])

  const chosen = off === null ? null : stems.map((stem) => stem.name).filter((name) => !off.includes(name))
  const file = useMixFile(jobId, stems, chosen, toast.error)

  const toggle = () => {
    if (!job) return
    if (mixing) {
      setMix(null)
      return
    }
    onEnter()
    player.setMuted([])
    setMix({ id: job.id, off: [] })
  }
  const toggleStem = (name: string) => {
    if (!job || off === null) return
    const next = off.includes(name) ? off.filter((other) => other !== name) : [...off, name]
    player.setMuted(next)
    setMix({ id: job.id, off: next })
  }
  const playPause = () => {
    if (state.status === 'loading') return
    if (state.status === 'ready') {
      player.toggle()
      return
    }
    void player.load(stems.map((stem) => ({ name: stem.name, url: fileUrl(connection, stem.path) }))).then(() => player.play())
  }

  return {
    toggle,
    mixer:
      off === null
        ? null
        : {
            off,
            playing: state.playing,
            loading: state.status === 'loading' ? { loaded: state.loaded, total: state.total } : null,
            file,
            toggleStem,
            playPause,
          },
  }
}

/* ---- the window proper ------------------------------------------------------------ */

export function QuickDrop({ recipes, models }: { recipes: Recipe[]; models: Model[] }) {
  const { data: loaded } = useJobs()
  const jobs = loaded ?? []
  const links = useOpenLinks()
  const flow = useDropFlow(recipes, models)
  usePaste(flow)
  const { addLinks } = flow
  const addLink = useCallback((url: string) => addLinks([url]), [addLinks])
  const actions = useJobActions()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const finishedId = useNewlyFinished(loaded)

  // Tell the tray icon what the queue is doing. Sent only when one of the facts changes.
  const activity = JSON.stringify(activityOf(jobs, finishedId, links))
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
  const { data: settings } = useSettings()
  // With "Hide empty stems" on, a song is laid out without its empty stems: the one pill
  // with sound is not lost among five without. They come back per song, by its "+N empty".
  const hideEmpty = Boolean(settings?.hide_empty_stems)
  const [emptyShown, setEmptyShown] = useState<string | null>(null)
  const found = jobs.find((job) => job.id === expanded)
  const laidOut = useMemo(
    () => (found ? { ...found, stems: emptyShown === found.id ? found.stems : splitEmpty(found.stems, hideEmpty).shown } : undefined),
    [found, hideEmpty, emptyShown],
  )
  const audition = useAudition(laidOut?.stems ?? [])
  const stopListening = audition.stop
  const { mixer, toggle: toggleMix } = useMixer(laidOut, stopListening)
  const finished = jobs.filter((job) => FINISHED.has(job.state)).length
  const held = jobs.filter((job) => job.held).length
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

      {jobs.length + links.length === 0 ? (
        <div className="m-3 mt-0 grid flex-1 place-items-center rounded-[14px] border border-dashed border-line-strong p-6 text-center">
          <div>
            <StemsMark />
            <h1 className="m-0 font-display text-[16px] font-semibold">Drop a song here</h1>
            <p className="mx-auto mt-1.5 mb-4 max-w-[250px] text-muted">
              Or paste a link to one. Its stems come back to this window, ready to drag into your DAW.
            </p>
            <div className="flex justify-center gap-2">
              <Button onClick={chooseFiles}>Choose files</Button>
              <Button onClick={flow.pasteLink} title={`Fetch the song behind a copied link (${shortcut('V')})`}>
                <Link2 size={14} />
                Paste link
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="mx-3 flex flex-none gap-1.5">
            <button
              type="button"
              className="drop-strip pressable flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-strong bg-transparent text-muted"
              onClick={chooseFiles}
            >
              <Plus size={14} />
              Drop a song, or choose files
            </button>
            <Tooltip label={`Paste a link to a song (${shortcut('V')})`}>
              <button
                type="button"
                aria-label="Paste a link"
                className="drop-strip pressable grid h-10 w-10 flex-none place-items-center rounded-[10px] border border-dashed border-line-strong bg-transparent text-muted"
                onClick={flow.pasteLink}
              >
                <Link2 size={15} />
              </button>
            </Tooltip>
          </div>
          {/* The header keeps the same scrollbar gutter as the list below (10px on Windows, none
              where scrollbars overlay, as on a Mac), so Clear finished ends where the rows end,
              and a gap under it keeps its hover from touching the first row. */}
          <div className="recent-gutter flex flex-none items-center justify-between pt-2 pr-2 pb-1 pl-4 text-muted">
            <span className="text-[11.5px] font-semibold tracking-wide uppercase">
              Recent <span className="tabular ml-1 font-normal text-faint">{jobs.length + links.length}</span>
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
          <ul className="recent-gutter m-0 min-h-0 flex-1 list-none overflow-y-auto px-2 pb-2" aria-label="Recent jobs">
            {/* Newest first: a song still being fetched is newer than every job. */}
            {[...links].reverse().map((link) => (
              <LinkRow key={link.id} link={link} compact />
            ))}
            {shown.map((job) => {
              const leftOut = splitEmpty(job.stems, hideEmpty)
              const stems = job.id === expanded && laidOut ? laidOut.stems : emptyShown === job.id ? job.stems : leftOut.shown
              return (
              <QuickRow
                key={job.id}
                job={stems === job.stems ? job : { ...job, stems }}
                empty={leftOut.hidden.length}
                emptyWord={leftOutWord(leftOut.hidden)}
                emptyShown={emptyShown === job.id}
                onEmpty={() => {
                  // The mix is of the stems on show: it ends when they change.
                  if (mixer && job.id === expanded) toggleMix()
                  stopListening()
                  setEmptyShown((id) => (id === job.id ? null : job.id))
                }}
                separatePart={Boolean(settings?.separate_selection)}
                expanded={job.id === expanded}
                fresh={picked === null && job.id === finishedId}
                onPick={() => setPick({ id: job.id, since: finishedId })}
                audition={audition.state}
                onListen={(stem) => audition.listen(stem, job.id)}
                mixer={job.id === expanded ? mixer : null}
                onMix={toggleMix}
                onStart={() => actions.start.mutate(job.id, { onError: toast.error })}
                onCancel={() => actions.cancel.mutate(job.id, { onError: toast.error })}
                onRetry={() => actions.retry.mutate(job.id, { onError: toast.error })}
                menu={jobMenuItems(job, {
                  start: () => actions.start.mutate(job.id, { onError: toast.error }),
                  cancel: () => actions.cancel.mutate(job.id, { onError: toast.error }),
                  retry: () => actions.retry.mutate(job.id, { onError: toast.error }),
                  // Lays the stems out in the row, unless they are already.
                  showStems: job.id === expanded ? undefined : () => setPick({ id: job.id, since: finishedId }),
                  ...revealHandlers(job, (message) => toast.show(message)),
                  remove: () => actions.remove.mutate(job.id, { onError: toast.error }),
                })}
              />
              )
            })}
          </ul>
        </>
      )}

      <DropOverlay onDrop={flow.addFiles} onLink={addLink} label={flow.label} manual={settings ? !settings.auto_start : false} />
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
  const { fit, note } = useCurrentFit(recipes, models)
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
      {/* Tight or too large for this machine: said in full, since a chip has no room here. */}
      {note && (
        <p className="m-0 text-[12px] text-muted" role="note" data-testid="fit-note" data-fit={fit}>
          {note}
        </p>
      )}
    </div>
  )
}

interface QuickRowProps {
  job: Job
  /** The separate_selection setting: a waiting song's part is all that Start separates. */
  separatePart?: boolean
  /** This job's stems are laid out for dragging. */
  expanded: boolean
  /** The stems arrived just now, so they may make an entrance. */
  fresh: boolean
  onPick: () => void
  /** What is being listened to, and the click that starts or stops a stem. */
  audition: AuditionState
  onListen: (stem: StemFile) => void
  /** The stems are being mixed: a click takes a stem out of the mix or puts it back. */
  mixer?: Mixer | null
  /** Turn mixing on or off for this song. */
  onMix?: () => void
  /**
   * How many of the song's stems are empty, while the "Hide empty stems" setting is on.
   * `job.stems` is then without them, unless `emptyShown`.
   */
  empty?: number
  /** What those are called: "empty", or "hidden" when the user hid one of them in the full app. */
  emptyWord?: 'empty' | 'hidden'
  emptyShown?: boolean
  /** Bring the empty stems back among the pills, or leave them out again. */
  onEmpty?: () => void
  onStart: () => void
  onCancel: () => void
  onRetry: () => void
  /** What a right-click on the row offers. */
  menu?: MenuItem[]
}

function startDrag(event: React.DragEvent, paths: string[]): void {
  // The browser's own drag carries no real file: cancel it and start a native one.
  event.preventDefault()
  window.openstems.startDrag(paths)
}

export function QuickRow({ job, separatePart = false, expanded, fresh, onPick, audition, onListen, mixer = null, onMix, empty = 0, emptyWord = 'empty', emptyShown = false, onEmpty, onStart, onCancel, onRetry, menu = [] }: QuickRowProps) {
  const theme = useTheme()
  const active = ACTIVE.has(job.state)
  const queued = job.state === 'queued'
  const done = job.state === 'done'
  const hasStems = done && job.stems.length > 0
  const pills = job.stems.slice(0, pillCount(job.stems.length))
  const more = job.stems.length - pills.length
  // A mix is of stems that can all be seen and clicked.
  const canMix = Boolean(onMix) && more === 0 && job.stems.length > 1
  // Left out of the pills and of the handle that drags them all.
  const leftOut = emptyShown ? 0 : empty

  return (
    <RowMenu
      items={menu}
      label={`${job.track_name} actions`}
      render={
        <li
          data-testid="quick-row"
          data-state={job.state}
          aria-expanded={hasStems ? expanded : undefined}
          className={cn('group/row row-hover mb-0.5 rounded-[10px] px-2.5 py-2', expanded && 'bg-raised')}
          onClick={hasStems ? onPick : undefined}
        />
      }
    >
      <div className="flex items-center gap-2.5">
        <StateIcon job={job} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            <SourceTitle name={job.track_name} source={job.track_path} />
          </div>
          <div className="truncate text-[12px] text-muted" data-testid="quick-status">
            {done ? `${job.recipe_name} · ${job.quality}${job.cached ? ' · from the cache' : ''}` : statusText(job, separatePart)}
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
            <IconButton label={`Show in ${words().fileManager}`} onClick={() => void window.openstems.revealInExplorer(job.stems[0]?.path ?? '')}>
              <FolderOpen size={14} />
            </IconButton>
          )}
        </div>

        {active && <span className="tabular flex-none font-mono text-[12px] text-muted">{formatPercent(job.progress)}</span>}

        {hasStems && (
          <Tooltip label={dragAllHint(job.stems.length, leftOut, emptyWord)}>
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
              {stemCount(job.stems.length)}
            </div>
          </Tooltip>
        )}
      </div>

      {active && (
        <div className="mt-2 ml-[24px]">
          <ProgressBar value={job.progress} indeterminate={job.state === 'preparing' && job.progress < 0.02} />
        </div>
      )}

      {/* Under the row, at its full width: beside the stems handle there is no room to read it. */}
      <JobNotes notes={job.notes} wrap className="mt-1 ml-[24px]" />

      {hasStems && expanded && (
        <div
          className="stem-pills mt-2 ml-[24px] flex flex-wrap gap-1.5"
          // Stems asked back by a click are there at once: the entrance is for stems that just arrived.
          data-fresh={fresh && !emptyShown}
          aria-label={`Stems of ${job.track_name}`}
          onClick={(event) => event.stopPropagation()}
        >
          {pills.map((stem, index) => {
            const mine = !mixer && audition.path === stem.path
            const inMix = mixer ? !mixer.off.includes(stem.name) : false
            const playing = mixer ? inMix && mixer.playing : mine && audition.status === 'playing'
            const act = () => (mixer ? mixer.toggleStem(stem.name) : onListen(stem))
            return (
              // Click to listen, drag to use: the two things one does with a stem. In a mix,
              // the click takes the stem out or puts it back; the drag is still the stem.
              <div
                key={stem.path}
                draggable
                role="button"
                tabIndex={0}
                aria-pressed={mixer ? inMix : playing}
                aria-label={mixer ? `${stem.name} in the mix` : playing ? `Stop ${stem.name}` : `Play ${stem.name}`}
                title={
                  mixer
                    ? 'Click to leave it out of the mix or put it back, drag for this stem alone'
                    : 'Click to listen, drag into your DAW or a folder'
                }
                data-testid="quick-stem"
                data-audition={mine ? audition.status : undefined}
                data-mix={mixer ? (inMix ? 'in' : 'out') : undefined}
                data-empty={stem.empty || undefined}
                className="stem-pill stem-handle"
                style={{ ['--i' as string]: Math.min(index, 8), ['--stem' as string]: stemColor(stem.name, theme) }}
                onClick={act}
                onDragStart={(event) => startDrag(event, [stem.path])}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  act()
                }}
              >
                {/* One slot for the dot and for the bars, so starting to play moves nothing. */}
                <span className="stem-mark" aria-hidden="true">
                  {playing ? (
                    <span className="audition-bars">
                      <span />
                      <span />
                      <span />
                    </span>
                  ) : (
                    <span className="stem-dot h-1.5 w-1.5 rounded-full" />
                  )}
                </span>
                <span className="truncate">{stem.name}</span>
              </div>
            )
          })}
          {more > 0 && (
            <button type="button" className="stem-pill pressable text-muted" onClick={() => void window.openstems.showMain()}>
              +{more} in the full app
            </button>
          )}
          {empty > 0 && onEmpty && (
            <button
              type="button"
              aria-expanded={emptyShown}
              title={
                emptyShown
                  ? `Leave the ${emptyWord} stems out again`
                  : emptyWord === 'empty'
                    ? 'Stems with nothing in them. Click to show them'
                    : 'Stems with nothing in them, and stems you hid. Click to show them'
              }
              data-testid="quick-empty"
              className="stem-pill pressable cursor-pointer text-muted"
              onClick={onEmpty}
            >
              {emptyShown ? `Hide ${emptyWord}` : `+${empty} ${emptyWord}`}
            </button>
          )}
          {canMix && (
            <button
              type="button"
              aria-pressed={mixer !== null}
              title="Hear the stems together, leave some out, and drag the result out as one file"
              data-testid="quick-mix"
              className="stem-pill mix-toggle pressable"
              onClick={onMix}
            >
              <SlidersHorizontal size={11} aria-hidden="true" />
              Mix
            </button>
          )}
        </div>
      )}

      {hasStems && expanded && mixer && <MixBar job={job} mixer={mixer} />}
    </RowMenu>
  )
}

/**
 * Under the stems while they are being mixed: play what is in, read what it is, drag it out.
 * The drag handle keeps its width whatever it says, so nothing beside it moves.
 */
function MixBar({ job, mixer }: { job: Job; mixer: Mixer }) {
  const names = job.stems.map((stem) => stem.name)
  const chosen = names.filter((name) => !mixer.off.includes(name))
  const whole = chosen.length === names.length
  const empty = chosen.length === 0
  // One stem alone is that stem's own file; more than one is a file the engine writes.
  const only = chosen.length === 1 ? job.stems.find((stem) => stem.name === chosen[0]) : undefined
  const path = only ? only.path : mixer.file.path
  const preparing = !only && mixer.file.status === 'preparing'
  const label = mixer.loading
    ? `Loading ${mixer.loading.loaded}/${mixer.loading.total}`
    : whole
      ? 'Click a stem to leave it out'
      : empty
        ? 'Nothing is in the mix'
        : capitalize(mixLabel(chosen, names, groupsOf(job.stems)))
  return (
    <div className="mix-bar mt-2 ml-[24px] flex items-center gap-2" data-testid="mix-bar" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        aria-label={mixer.playing ? 'Pause the mix' : 'Play the mix'}
        disabled={empty || mixer.loading !== null}
        className="mix-play pressable"
        onClick={mixer.playPause}
      >
        {mixer.loading ? (
          <span className="spinner" aria-hidden="true" />
        ) : mixer.playing ? (
          <Pause size={11} fill="currentColor" />
        ) : (
          <Play size={11} fill="currentColor" className="ml-px" />
        )}
      </button>
      <span
        className={cn('min-w-0 flex-1 truncate text-[12px]', whole || empty || mixer.loading ? 'text-muted' : 'font-medium')}
        data-testid="mix-label"
        role="status"
      >
        {label}
      </span>
      {!whole && !empty && (
        <div
          draggable={Boolean(path)}
          role="button"
          tabIndex={0}
          aria-disabled={!path}
          aria-label={preparing ? 'Preparing the mix' : `Drag the mix of ${job.track_name}`}
          title="Drag this mix into your DAW or a folder, as one file"
          data-testid="mix-drag"
          data-state={only ? 'ready' : mixer.file.status}
          className={cn('btn btn-sm mix-drag flex-none', path ? 'pressable stem-handle' : 'text-muted')}
          onDragStart={(event) => (path ? startDrag(event, [path]) : event.preventDefault())}
        >
          {preparing ? <span className="spinner" aria-hidden="true" /> : <Blend size={13} />}
          {preparing ? 'Preparing' : 'Drag mix'}
        </div>
      )}
    </div>
  )
}
