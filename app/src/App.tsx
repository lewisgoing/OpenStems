import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { Boxes, Download, History, ListMusic, Settings as SettingsIcon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SetupStatus, TorchVariant } from '../electron/bridge'
import { VARIANT_CARDS, VARIANT_DOWNLOAD, VARIANT_LABEL, variantsFor } from '../electron/variant'
import type { Job, Model, Recipe, StemSet } from './api/client'
import { EngineProvider } from './api/engine'
import { type NewJobRange, keys, useJobs, useModels, useRecipes, useSetAnalysis, useSetJobRange, useSettings } from './api/queries'
import { useEngineStatus } from './api/status'
import { DropOverlay } from './components/DropOverlay'
import { type PanelMix, StemsPanel, type StemsPanelProps } from './components/StemsPanel'
import { ThemeSwitch } from './components/ThemeSwitch'
import { ToastProvider, useToast } from './components/toast'
import { Button, Segmented, TooltipProvider } from './components/ui'
import { UpdatePill } from './components/Update'
import { Welcome } from './components/Welcome'
import { Wordmark } from './components/Wordmark'
import { cn } from './lib/format'
import { isMac, modKey, shortcut, words } from './platform'
import { PendingDownload, useDropFlow, usePaste } from './state/dropflow'
import { SelectionProvider } from './state/selection'
import { TrimEditor } from './trimmer/TrimEditor'
import { type TrimMemory, recall } from './trimmer/memory'
import { pickOfAudible } from './trimmer/model'
import { type GridChange, type TrimSong, songOfJob, songOfStemSet } from './trimmer/song'
import { HistoryView } from './views/HistoryView'
import { ModelsView } from './views/ModelsView'
import { QueueView } from './views/QueueView'
import { SettingsView } from './views/SettingsView'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
})

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={450} closeDelay={0}>
        <ToastProvider>
          <div className="flex h-full flex-col">
            <TitleBar />
            <EngineGate />
          </div>
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function TitleBar() {
  return (
    <div className="title-bar drag-region flex h-10 flex-none items-center gap-2 border-b border-line">
      <Wordmark />
      <span className="flex-1" />
      {/* Clear of the window buttons, which Windows draws over the right end of this bar. A Mac
          has its buttons at the left (`.title-bar` leaves room for them) and this margin is 0. */}
      <div style={{ marginRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))' }}>
        <UpdatePill />
      </div>
    </div>
  )
}

/* ---- engine start, first-run setup and failure -------------------------------- */

function EngineGate() {
  const toast = useToast()
  const { engine, setup, connection } = useEngineStatus()

  if (setup.state !== 'ready') return <SetupScreen status={setup} />
  if (connection) {
    return (
      <EngineProvider connection={connection} onNotice={(message, level) => toast.show(message, { kind: level })}>
        <Shell />
      </EngineProvider>
    )
  }
  return (
    <CenteredMessage>
      {engine.state === 'failed' ? (
        <>
          <h1 className="m-0 font-display text-[16px] font-semibold">The engine did not start</h1>
          <p className="mt-2 mb-4 max-w-[460px] whitespace-pre-line text-muted" role="alert">
            {engine.error}
          </p>
          <Button variant="primary" onClick={() => void window.openstems.restartEngine()}>
            Try again
          </Button>
        </>
      ) : (
        <div className="flex items-center gap-3 text-muted" role="status">
          <span className="spinner" />
          {engine.state === 'starting' ? engine.detail : 'Starting'}
        </div>
      )}
    </CenteredMessage>
  )
}

function CenteredMessage({ children }: { children: ReactNode }) {
  return <div className="grid flex-1 place-items-center p-8 text-center">{children}</div>
}

export function SetupScreen({ status }: { status: SetupStatus }) {
  const log = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [status.log])
  const running = status.state === 'running'
  // The build follows the detection until the user picks one themselves.
  const [picked, setPicked] = useState<TorchVariant | null>(null)
  const variant = picked ?? status.variant
  const offRecommendation = status.recommended !== undefined && variant !== status.recommended
  // A Mac has one build: it is named, with nothing to choose.
  const builds = status.variants ?? variantsFor(window.openstems.info.platform)
  const single = builds.length === 1
  const mac = isMac()
  // After an app update the engine is brought up to date by itself: nothing to choose.
  if (status.updating) {
    return (
      <CenteredMessage>
        <div className="flex items-center gap-3 text-muted" role="status">
          <span className="spinner" />
          Updating the audio engine
        </div>
      </CenteredMessage>
    )
  }
  return (
    <CenteredMessage>
      <div className="w-full max-w-[560px] text-left">
        <h1 className="m-0 font-display text-[17px] font-semibold">Set up the audio engine</h1>
        <p className="mt-2 mb-4 text-muted">
          OpenStems needs its Python environment before the first separation. This downloads Python, PyTorch for{' '}
          {mac ? VARIANT_LABEL[variant] : `${VARIANT_LABEL[variant]} graphics cards`} and the model code (
          {VARIANT_DOWNLOAD[variant]}) into {words().profile}. It happens once.
        </p>
        <div className="mb-4 rounded-[10px] border border-line bg-surface px-3.5 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="font-medium">{single ? 'Engine build' : 'Graphics card'}</span>
            {single ? (
              <span className="text-muted">
                {VARIANT_LABEL[variant]} · {VARIANT_CARDS[variant]}
              </span>
            ) : running ? (
              <span className="text-muted">{VARIANT_LABEL[variant]}</span>
            ) : (
              <Segmented
                label="Graphics card"
                value={variant}
                options={builds.map((value) => ({ value, label: VARIANT_LABEL[value] }))}
                onChange={setPicked}
              />
            )}
          </div>
          {/* A machine that cannot be set up is told once, in the alert below. */}
          {!status.unsupported && (
            <p className="mt-2 mb-0 text-[12.5px] text-muted" role="status">
              {status.detected ? status.note : single ? 'Checking this Mac' : 'Checking your graphics card'}
              {offRecommendation &&
                status.recommended &&
                ` The ${VARIANT_LABEL[status.recommended]} build is the one that fits this ${words().computer}.`}
            </p>
          )}
        </div>
        {status.unsupported && (
          <p className="mb-3 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-danger" role="alert">
            {status.unsupported}
          </p>
        )}
        {status.state === 'failed' && !status.unsupported && (
          <p className="mb-3 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-danger" role="alert">
            Setup failed: {status.error}
          </p>
        )}
        {status.log.length > 0 && (
          <pre ref={log} className="mb-4 h-[180px] overflow-y-auto rounded-[8px] border border-line bg-surface p-3 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-muted select-text">
            {status.log.join('\n')}
          </pre>
        )}
        <Button
          variant="primary"
          disabled={running || !status.detected || Boolean(status.unsupported)}
          onClick={() => void window.openstems.runSetup(variant)}
        >
          {running && <span className="spinner !border-t-accent-ink" />}
          {running ? 'Setting up' : status.state === 'failed' ? 'Try again' : 'Set up'}
        </Button>
      </div>
    </CenteredMessage>
  )
}

/* ---- the app proper ----------------------------------------------------------- */

type View = 'queue' | 'history' | 'models' | 'settings'
const VIEWS: { id: View; label: string; icon: typeof ListMusic }[] = [
  { id: 'queue', label: 'Queue', icon: ListMusic },
  { id: 'history', label: 'History', icon: History },
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
]

function Shell() {
  const { data: settings } = useSettings()
  const { data: recipes } = useRecipes()
  const { data: models } = useModels()
  if (!settings || !recipes || !models) {
    return (
      <CenteredMessage>
        <span className="spinner" role="status" aria-label="Loading" />
      </CenteredMessage>
    )
  }
  return (
    <SelectionProvider settings={settings} recipes={recipes}>
      <Workspace recipes={recipes} models={models.models} />
    </SelectionProvider>
  )
}

/** Where a song shown in the stems panel or the trimmer comes from: the queue, or the History. */
type SongOrigin = { kind: 'job'; id: string } | { kind: 'set'; set: StemSet }

type PanelState = Omit<StemsPanelProps, 'onClose'> & { key: string; origin: SongOrigin }

/** A song open in the trimmer, which takes the place of the view and the panel. */
interface Trimming {
  origin: SongOrigin
  initial: TrimMemory
  /** Opened from the keyboard: it appears at once. */
  instant: boolean
  /** On its way in: what it covers is still drawn under its fade. */
  entering: boolean
  /** On its way out: the view is already back under it. */
  leaving: boolean
  /** The control that opened it, which takes the focus again after a keyboard Back. */
  control: string
}

/** How long the way in takes; a little longer than its fade, so the fade ends first. */
const ENTER_MS = 240
/** How long the way back takes; a little longer than its fade, so the fade ends first. */
const LEAVE_MS = 160

function Workspace({ recipes, models }: { recipes: Recipe[]; models: Model[] }) {
  const [view, setView] = useState<{ id: View; animate: boolean }>({ id: 'queue', animate: false })
  const [panel, setPanel] = useState<PanelState | null>(null)
  // Back from the trimmer the panel is simply there again: it slid in once already.
  const [panelSettled, setPanelSettled] = useState(false)
  const [trim, setTrim] = useState<Trimming | null>(null)
  const { data: jobs = [] } = useJobs()
  // New jobs bring the queue into view.
  const trimNow = useRef(trim)
  trimNow.current = trim
  // While a song is open in the trimmer the view under it stays: Back returns there, and the
  // sidebar counts the new songs.
  const showQueue = useCallback(() => {
    if (trimNow.current) return
    setView((v) => (v.id === 'queue' ? v : { id: 'queue', animate: true }))
  }, [])
  const flow = useDropFlow(recipes, models, showQueue)
  const { submit, addFiles, addLinks, pasteLink } = flow
  usePaste(flow)
  const addLink = useCallback((url: string) => addLinks([url]), [addLinks])
  const { data: settings } = useSettings()

  /* ---- the trimmer ---- */

  const leaveTimer = useRef(0)
  const enterTimer = useRef(0)
  const refocus = useRef<string | null>(null)
  useEffect(
    () => () => {
      window.clearTimeout(leaveTimer.current)
      window.clearTimeout(enterTimer.current)
    },
    [],
  )

  /** Leave the trimmer at once, for another view. The panel comes back as it was, at once. */
  const leaveTrim = useCallback(() => {
    window.clearTimeout(leaveTimer.current)
    window.clearTimeout(enterTimer.current)
    setPanelSettled(true)
    setTrim(null)
  }, [])

  const openTrim = (origin: SongOrigin, song: TrimSong, how: { audible?: string[] | null; instant: boolean; control: string }) => {
    window.clearTimeout(leaveTimer.current)
    window.clearTimeout(enterTimer.current)
    const kept = recall(song.id)
    // From the stems panel, what is heard there is what is trimmed; else what was left last time.
    const pick = how.audible !== undefined ? pickOfAudible(song, how.audible) : kept.pick
    setTrim({ origin, initial: { ...kept, pick }, instant: how.instant, entering: !how.instant, leaving: false, control: how.control })
    // Once the editor has come in, what it covers is no longer drawn under it.
    if (!how.instant) enterTimer.current = window.setTimeout(() => setTrim((current) => (current?.entering ? { ...current, entering: false } : current)), ENTER_MS)
  }

  const backFromTrim = useCallback(
    (instant: boolean) => {
      setPanelSettled(true)
      if (instant) {
        refocus.current = trimNow.current?.control ?? null
        leaveTrim()
        return
      }
      setTrim((current) => (current ? { ...current, entering: false, leaving: true } : current))
      window.clearTimeout(enterTimer.current)
      window.clearTimeout(leaveTimer.current)
      leaveTimer.current = window.setTimeout(() => setTrim((current) => (current?.leaving ? null : current)), LEAVE_MS)
    },
    [leaveTrim],
  )

  // Back from the keyboard, the focus returns to the Trim control the trimmer was opened from.
  useEffect(() => {
    if (trim || !refocus.current) return
    document.querySelector<HTMLElement>(refocus.current)?.focus()
    refocus.current = null
  }, [trim])

  const trimOrigin = trim?.origin
  const trimJob = trimOrigin?.kind === 'job' ? jobs.find((job) => job.id === trimOrigin.id) : undefined
  const trimSet = trimOrigin?.kind === 'set' ? trimOrigin.set : undefined
  // The song comes live from the jobs (or from its stem set as last saved), so a retag's
  // renamed stems, or a waiting song that got separated meanwhile, flow in.
  const trimSong = useMemo(() => (trimJob ? songOfJob(trimJob) : trimSet ? songOfStemSet(trimSet) : null), [trimJob, trimSet])
  // A song taken off the list (here or in the quick-drop window) takes the trimmer with it.
  useEffect(() => {
    if (trim && !trimSong) leaveTrim()
  }, [trim, trimSong, leaveTrim])

  const queryClient = useQueryClient()
  const setAnalysis = useSetAnalysis()
  /** One tempo per song: the trimmer's grid is saved as the tempo field saves it. */
  const commitGrid = async (origin: SongOrigin, change: GridChange) => {
    if (origin.kind === 'job') {
      const job = await setAnalysis.job.mutateAsync({ id: origin.id, ...change })
      // The trimmer shows the saved grid at once, before the list is fetched again.
      queryClient.setQueryData<Job[]>(keys.jobs, (list = []) => list.map((other) => (other.id === job.id ? job : other)))
      return
    }
    const set = await setAnalysis.stemSet.mutateAsync({ directory: origin.set.directory, ...change })
    setTrim((current) =>
      current?.origin.kind === 'set' && current.origin.set.directory === set.directory ? { ...current, origin: { kind: 'set', set } } : current,
    )
    setPanel((shown) => (shown?.key === set.directory ? { ...shown, stems: set.stems, analysis: set.analysis, origin: { kind: 'set', set } } : shown))
  }

  const setRange = useSetJobRange()
  /** The part of a waiting song that Start separates alone, while the setting says so. */
  const commitRange = async (id: string, range: NewJobRange) => {
    const job = await setRange.mutateAsync({ id, range })
    // The row and the trimmer say it at once, before the list is fetched again.
    queryClient.setQueryData<Job[]>(keys.jobs, (list = []) => list.map((other) => (other.id === job.id ? job : other)))
  }

  const trimFromRow = (job: Job, instant: boolean) =>
    openTrim({ kind: 'job', id: job.id }, songOfJob(job), { instant, control: `[data-trim-song="${job.id}"]` })

  // Ctrl+1..4 (Cmd on a Mac) switch views, and leave the trimmer. Keyboard-initiated, so the
  // view appears at once.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!modKey(event) || event.altKey || event.shiftKey) return
      const target = VIEWS[Number(event.key) - 1]
      if (!target) return
      event.preventDefault()
      leaveTrim()
      setView({ id: target.id, animate: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leaveTrim])

  // Settings from the Mac application menu (Cmd+,). A menu or keyboard action, so no animation.
  // The preload also leaves a mark on the root element, for a pick made before this ran.
  useEffect(() => {
    const onSettings = () => {
      delete document.documentElement.dataset.openView
      leaveTrim()
      setPanel(null)
      setView({ id: 'settings', animate: false })
    }
    if (document.documentElement.dataset.openView === 'settings') onSettings()
    window.addEventListener('openstems:settings', onSettings)
    return () => window.removeEventListener('openstems:settings', onSettings)
  }, [leaveTrim])

  const showJob = (job: Job | null) => {
    setPanelSettled(false)
    setPanel(
      job && job.output_dir
        ? {
            key: job.id,
            origin: { kind: 'job', id: job.id },
            title: job.track_name,
            source: job.track_path,
            subtitle: job.recipe_name,
            directory: job.output_dir,
            stems: job.stems,
            analysis: job.analysis,
            notes: job.notes,
          }
        : null,
    )
  }
  const showSet = (set: StemSet | null) => {
    setPanelSettled(false)
    setPanel(
      set
        ? {
            key: set.directory,
            origin: { kind: 'set', set },
            title: set.track_name,
            source: set.source_exists ? set.track_path : undefined,
            subtitle: set.recipe_name,
            directory: set.directory,
            stems: set.stems,
            analysis: set.analysis,
          }
        : null,
    )
  }

  // A song's panel in the queue follows its job, so stems the trimmer renamed come back right.
  const panelJob = panel?.origin.kind === 'job' ? jobs.find((job) => job.id === panel.key && job.state === 'done') : undefined

  const trimFromPanel = (audible: string[] | null, how: { instant: boolean; mix: PanelMix }) => {
    if (!panel) return
    const song = panel.origin.kind === 'job' ? (panelJob ? songOfJob(panelJob) : null) : songOfStemSet(panel.origin.set)
    if (!song) return
    // Solo and mute come back with the panel.
    setPanel((shown) => (shown ? { ...shown, initialMix: how.mix } : shown))
    openTrim(panel.origin, song, { audible, instant: how.instant, control: '[data-testid="panel-trim"]' })
  }

  // Close the panel if its job is removed from the list.
  useEffect(() => {
    if (panel && view.id === 'queue' && !jobs.some((j) => j.id === panel.key)) setPanel(null)
  }, [jobs, panel, view.id])

  // While the trimmer is over the view, the view stays as it was under it (its scroll, the
  // History's search), out of reach of the pointer, the keys and screen readers, and once the
  // trimmer has come in it is not drawn. Back finds it as it was left, with nothing to replay.
  // Only the stems panel goes: its player and its Space must not run behind the trimmer.
  const covering = trim !== null && !trim.leaving
  const hidden = covering && !trim.entering
  const showPanel = panel !== null && (view.id === 'queue' || view.id === 'history') && (!covering || trim.entering)

  const activeCount = jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.state)).length
  const downloading = models.filter((m) => m.download?.state === 'downloading' || m.download?.state === 'verifying').length

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-[168px] flex-none flex-col gap-0.5 border-r border-line p-2" aria-label="Views">
        {VIEWS.map(({ id, label, icon: Icon }, index) => (
          <button
            key={id}
            type="button"
            aria-current={view.id === id ? 'page' : undefined}
            title={`${label} (${shortcut(String(index + 1))})`}
            className={cn(
              'nav-item press flex h-8 items-center gap-2.5 rounded-[8px] border-0 bg-transparent px-2.5 text-left font-medium text-muted',
              view.id === id && '!bg-raised !text-text',
            )}
            onClick={() => {
              leaveTrim()
              setPanel(null)
              setView({ id, animate: true })
            }}
          >
            <Icon size={15} />
            <span className="flex-1">{label}</span>
            {id === 'queue' && activeCount > 0 && <span className="tabular text-[11.5px] text-accent-fg">{activeCount}</span>}
            {id === 'models' && downloading > 0 && <Download size={12} className="text-accent-fg" />}
          </button>
        ))}
        <ThemeSwitch className="mt-auto w-full" />
      </nav>

      <div className="relative flex min-w-0 flex-1">
      <main
        key={view.id}
        className="view flex min-w-0 flex-1"
        data-animate={view.animate}
        data-covered={hidden || undefined}
        inert={covering}
        aria-hidden={covering || undefined}
      >
        {view.id === 'queue' && (
          <QueueView
            recipes={recipes}
            models={models}
            selectedJob={panel?.key ?? null}
            onSelect={showJob}
            onAddFiles={addFiles}
            onPasteLink={pasteLink}
            onTrim={trimFromRow}
            covered={covering}
          />
        )}
        {view.id === 'history' && (
          <HistoryView
            recipes={recipes}
            selected={panel?.key ?? null}
            onSelect={showSet}
            onRerun={(trackPath, recipeId) => submit([trackPath], { recipe: recipeId })}
          />
        )}
        {view.id === 'models' && <div className="min-w-0 flex-1"><ModelsView /></div>}
        {view.id === 'settings' && <div className="min-w-0 flex-1"><SettingsView recipes={recipes} /></div>}
        {showPanel && panel && (
          <div className="panel flex h-full flex-none" data-settled={panelSettled || undefined}>
          <StemsPanel
            key={panel.key}
            title={panel.title}
            source={panel.source}
            subtitle={panel.subtitle}
            directory={panel.directory}
            stems={panelJob?.stems ?? panel.stems}
            analysis={panelJob?.analysis ?? panel.analysis}
            notes={panelJob?.notes ?? panel.notes}
            initialMix={panel.initialMix}
            frozen={covering}
            onRetagged={(set) =>
              setPanel((shown) =>
                shown ? { ...shown, stems: set.stems, analysis: set.analysis, origin: shown.origin.kind === 'set' ? { kind: 'set', set } : shown.origin } : shown,
              )
            }
            onTrim={trimFromPanel}
            onClose={() => setPanel(null)}
          />
          </div>
        )}
      </main>
      {trim && trimSong && (
        <TrimEditor
          key={trimSong.id}
          song={trimSong}
          initial={trim.initial}
          instant={trim.instant}
          leaving={trim.leaving}
          onBack={backFromTrim}
          onCommit={(change) => commitGrid(trim.origin, change)}
          onRange={trimJob ? (range) => commitRange(trimJob.id, range) : undefined}
        />
      )}
      </div>

      <DropOverlay onDrop={addFiles} onLink={addLink} label={flow.label} manual={settings ? !settings.auto_start : false} />
      <Welcome models={models} onDownloaded={() => setView({ id: 'models', animate: true })} />
      <PendingDownload flow={flow} models={models} />
    </div>
  )
}
