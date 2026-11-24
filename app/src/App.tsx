import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Boxes, Download, History, ListMusic, Settings as SettingsIcon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { SetupStatus, TorchVariant } from '../electron/bridge'
import { VARIANT_CARDS, VARIANT_DOWNLOAD, VARIANT_LABEL, variantsFor } from '../electron/variant'
import type { Job, Model, Recipe, StemSet } from './api/client'
import { EngineProvider } from './api/engine'
import { useJobs, useModelActions, useModels, useRecipes, useSettings } from './api/queries'
import { useEngineStatus } from './api/status'
import { DropOverlay } from './components/DropOverlay'
import { StemsPanel, type StemsPanelProps } from './components/StemsPanel'
import { ThemeSwitch } from './components/ThemeSwitch'
import { ToastProvider, useToast } from './components/toast'
import { Button, Dialog, Segmented, TooltipProvider } from './components/ui'
import { UpdatePill } from './components/Update'
import { Wordmark } from './components/Wordmark'
import { cn, formatBytes } from './lib/format'
import { recommendedModels, recommendedReason } from './lib/memory'
import { isMac, modKey, shortcut, words } from './platform'
import { PendingDownload, useDropFlow, usePaste } from './state/dropflow'
import { useMachine } from './state/machine'
import { SelectionProvider } from './state/selection'
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

function Workspace({ recipes, models }: { recipes: Recipe[]; models: Model[] }) {
  const [view, setView] = useState<{ id: View; animate: boolean }>({ id: 'queue', animate: false })
  const [panel, setPanel] = useState<(Omit<StemsPanelProps, 'onClose'> & { key: string }) | null>(null)
  const { data: jobs = [] } = useJobs()
  // New jobs bring the queue into view.
  const showQueue = useCallback(() => setView((v) => (v.id === 'queue' ? v : { id: 'queue', animate: true })), [])
  const flow = useDropFlow(recipes, models, showQueue)
  const { submit, addFiles, addLinks, pasteLink } = flow
  usePaste(flow)
  const addLink = useCallback((url: string) => addLinks([url]), [addLinks])
  const { data: settings } = useSettings()

  // Ctrl+1..4 (Cmd on a Mac) switch views. Keyboard-initiated, so the view appears at once.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!modKey(event) || event.altKey || event.shiftKey) return
      const target = VIEWS[Number(event.key) - 1]
      if (!target) return
      event.preventDefault()
      setView({ id: target.id, animate: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Settings from the Mac application menu (Cmd+,). A menu or keyboard action, so no animation.
  // The preload also leaves a mark on the root element, for a pick made before this ran.
  useEffect(() => {
    const onSettings = () => {
      delete document.documentElement.dataset.openView
      setPanel(null)
      setView({ id: 'settings', animate: false })
    }
    if (document.documentElement.dataset.openView === 'settings') onSettings()
    window.addEventListener('openstems:settings', onSettings)
    return () => window.removeEventListener('openstems:settings', onSettings)
  }, [])

  const showJob = (job: Job | null) =>
    setPanel(
      job && job.output_dir
        ? {
            key: job.id,
            title: job.track_name,
            subtitle: job.recipe_name,
            directory: job.output_dir,
            stems: job.stems,
            analysis: job.analysis,
            notes: job.notes,
          }
        : null,
    )
  const showSet = (set: StemSet | null) =>
    setPanel(
      set
        ? {
            key: set.directory,
            title: set.track_name,
            subtitle: set.recipe_name,
            directory: set.directory,
            stems: set.stems,
            analysis: set.analysis,
          }
        : null,
    )

  // Close the panel if its job is removed from the list.
  useEffect(() => {
    if (panel && view.id === 'queue' && !jobs.some((j) => j.id === panel.key)) setPanel(null)
  }, [jobs, panel, view.id])

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

      <main key={view.id} className="view flex min-w-0 flex-1" data-animate={view.animate}>
        {view.id === 'queue' && (
          <QueueView recipes={recipes} models={models} selectedJob={panel?.key ?? null} onSelect={showJob} onAddFiles={addFiles} onPasteLink={pasteLink} />
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
        {panel && (view.id === 'queue' || view.id === 'history') && (
          <div className="panel flex h-full flex-none">
          <StemsPanel
            key={panel.key}
            title={panel.title}
            subtitle={panel.subtitle}
            directory={panel.directory}
            stems={panel.stems}
            analysis={panel.analysis}
            notes={panel.notes}
            onRetagged={(set) => setPanel((shown) => (shown ? { ...shown, stems: set.stems, analysis: set.analysis } : shown))}
            onClose={() => setPanel(null)}
          />
          </div>
        )}
      </main>

      <DropOverlay onDrop={addFiles} onLink={addLink} label={flow.label} manual={settings ? !settings.auto_start : false} />
      <SeedOffer models={models} onStarted={() => setView({ id: 'models', animate: true })} />
      <PendingDownload flow={flow} models={models} />
    </div>
  )
}

/* ---- first run: offer the recommended models -------------------------------------- */

const SEED_OFFER_KEY = 'openstems.seed-offer.v1'

export function SeedOffer({ models, onStarted }: { models: Model[]; onStarted: () => void }) {
  const actions = useModelActions()
  const toast = useToast()
  const nothingInstalled = models.every((m) => m.status !== 'installed' && !m.download)
  const [open, setOpen] = useState(() => nothingInstalled && localStorage.getItem(SEED_OFFER_KEY) === null)
  const machine = useMachine()
  // What the engine recommends for this machine. Where it is not the usual set, say why.
  const seed = recommendedModels(models)
  const reason = recommendedReason(models, machine)
  const close = () => {
    localStorage.setItem(SEED_OFFER_KEY, 'seen')
    setOpen(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title="Download the recommended models?"
      description={`${seed.length} models, ${formatBytes(seed.reduce((sum, m) => sum + m.bytes, 0))} in total. ${reason ?? 'They cover every standard recipe: full song, vocals, drum kit, melody and cleanup.'} You can also download models one at a time later.`}
      footer={
        <>
          <Button onClick={close}>Not now</Button>
          <Button
            variant="primary"
            onClick={() => {
              for (const model of seed) actions.pull.mutate(model.id, { onError: toast.error })
              close()
              onStarted()
            }}
          >
            <Download size={14} />
            Download
          </Button>
        </>
      }
    >
      <ul className="m-0 flex max-h-[200px] list-none flex-col gap-1 overflow-y-auto p-0 text-[12.5px] text-muted">
        {seed.map((model) => (
          <li key={model.id} className="flex justify-between gap-4">
            <span className="truncate">{model.name}</span>
            <span className="tabular flex-none font-mono text-faint">{formatBytes(model.bytes)}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
