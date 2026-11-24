import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { Download, FolderOpen } from 'lucide-react'
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type { FolderSpace } from '../../electron/space'
import type { Model, Settings, SettingsPatch } from '@/api/client'
import { useModelActions, usePatchSettings, useSettings } from '@/api/queries'
import { FORMATS, carriesTempo, stemBytes } from '@/components/FormatSelect'
import { useToast } from '@/components/toast'
import { Button, IconButton, Switch } from '@/components/ui'
import { formatBytes } from '@/lib/format'
import { recommendedModels, recommendedReason } from '@/lib/memory'
import { words } from '@/platform'
import { useMachine } from '@/state/machine'

/**
 * The first time the app opens with the engine ready: where files go, how stems are saved,
 * and the models to start with, in three short steps. Every choice is saved as it is made
 * and is the same setting as in Settings, so closing early keeps what was chosen.
 * `docs/adr/0021-welcome.md`.
 */

/** Seen once. The key of the model offer it replaced counts as seen too: an existing install. */
export const WELCOME_KEY = 'openstems.welcome.v1'
const SEED_OFFER_KEY = 'openstems.seed-offer.v1'

/** The event Settings sends to walk through the welcome again (`showWelcomeAgain`). */
const AGAIN_EVENT = 'openstems:welcome'

/** Forget that the welcome was seen and open it now, from the first step. For Settings. */
export function showWelcomeAgain(): void {
  localStorage.removeItem(WELCOME_KEY)
  window.dispatchEvent(new Event(AGAIN_EVENT))
}

/** Whether to show the welcome: a first start, with no models yet, or forced by a test. */
export function shouldWelcome(models: Model[], storage: Pick<Storage, 'getItem'>, forced = false): boolean {
  if (forced) return true
  if (storage.getItem(WELCOME_KEY) !== null || storage.getItem(SEED_OFFER_KEY) !== null) return false
  return models.every((m) => m.status !== 'installed' && !m.download)
}

/** The song length the format sizes are given for: a usual song. */
const SONG_SECONDS = 4 * 60

const STEPS = ['Folders', 'Format', 'Models'] as const

export function Welcome({ models, onDownloaded }: { models: Model[]; onDownloaded: () => void }) {
  const [open, setOpen] = useState(() => shouldWelcome(models, localStorage, window.openstems.info.welcome === true))
  const [step, setStep] = useState(0)
  // Which way the step content enters, and whether it moves at all: a step reached from the
  // keyboard appears at once.
  const [motion, setMotion] = useState<{ dir: 1 | -1; animate: boolean }>({ dir: 1, animate: false })
  // The dialog itself takes focus, not a button in it: no focus ring before anything is pressed.
  const popup = useRef<HTMLDivElement>(null)
  const { data: settings } = useSettings()
  const patch = usePatchSettings()
  const toast = useToast()
  const save = (changes: SettingsPatch) => patch.mutate(changes, { onError: toast.error })

  const close = () => {
    localStorage.setItem(WELCOME_KEY, 'seen')
    setOpen(false)
  }
  // Asked for again from Settings: from the start, the dialog's own entrance and no slide.
  useEffect(() => {
    const again = () => {
      setStep(0)
      setMotion({ dir: 1, animate: false })
      setOpen(true)
    }
    window.addEventListener(AGAIN_EVENT, again)
    return () => window.removeEventListener(AGAIN_EVENT, again)
  }, [])
  const go = (next: number) => (event: MouseEvent) => {
    // A click from the keyboard (Enter or Space on the button) has no pointer detail.
    setMotion({ dir: next > step ? 1 : -1, animate: event.detail > 0 })
    setStep(next)
  }

  if (!settings) return null
  // What is left to fetch: a models folder picked in the first step may hold some already.
  const seed = recommendedModels(models).filter((m) => m.status !== 'installed' && !m.download)
  const seedBytes = seed.reduce((sum, m) => sum + m.bytes, 0)

  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="dialog-backdrop z-40" />
        <BaseDialog.Popup ref={popup} initialFocus={popup} className="dialog welcome z-40" data-testid="welcome">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[12px] font-medium text-faint">Welcome to OpenStems</span>
            <ol className="welcome-steps m-0 flex list-none gap-1.5 p-0" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
              {STEPS.map((name, index) => (
                <li key={name} className="welcome-step-mark" data-done={index <= step} title={name} />
              ))}
            </ol>
          </div>

          <div
            key={step}
            className="welcome-body"
            data-dir={motion.dir}
            data-animate={motion.animate}
          >
            {step === 0 && <FoldersStep settings={settings} seedBytes={seedBytes} onPick={save} />}
            {step === 1 && <FormatStep settings={settings} onChange={save} />}
            {step === 2 && <ModelsStep models={models} seed={seed} seedBytes={seedBytes} settings={settings} />}
          </div>

          <div className="mt-5 flex items-center gap-2">
            {step > 0 ? (
              <Button variant="ghost" onClick={go(step - 1)}>
                Back
              </Button>
            ) : (
              <Button variant="ghost" onClick={close}>
                Skip
              </Button>
            )}
            <span className="flex-1" />
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={go(step + 1)} >
                Continue
              </Button>
            ) : seed.length === 0 ? (
              <Button variant="primary" onClick={close} >
                Done
              </Button>
            ) : (
              <>
                <Button onClick={close}>Not now</Button>
                <ModelsDownload seed={seed} onStarted={() => (close(), onDownloaded())} />
              </>
            )}
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

function ModelsDownload({ seed, onStarted }: { seed: Model[]; onStarted: () => void }) {
  const actions = useModelActions()
  const toast = useToast()
  return (
    <Button
      variant="primary"
      onClick={() => {
        for (const model of seed) actions.pull.mutate(model.id, { onError: toast.error })
        onStarted()
      }}
    >
      <Download size={14} />
      Download
    </Button>
  )
}

function StepTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <BaseDialog.Title className="m-0 mt-3 font-display text-[17px] font-semibold">{title}</BaseDialog.Title>
      {children && <BaseDialog.Description className="mt-1.5 mb-0 text-muted">{children}</BaseDialog.Description>}
    </>
  )
}

/* ---- step 1: folders ---------------------------------------------------------- */

/** Free space on the drive a folder is on, asked again when the folder changes. */
export function useFolderSpace(path: string): FolderSpace | null {
  const [space, setSpace] = useState<{ path: string; value: FolderSpace | null } | null>(null)
  useEffect(() => {
    let live = true
    void window.openstems.folderSpace(path).then((value) => {
      if (live) setSpace({ path, value })
    })
    return () => {
      live = false
    }
  }, [path])
  return space?.path === path ? space.value : null
}

/**
 * Whether the recommended models fit on the models folder's drive, with a little to spare
 * (a gigabyte, for the download's partial files and everything else on the drive).
 */
export function modelsFit(space: FolderSpace | null, needed: number): boolean {
  return space === null || needed === 0 || space.free >= needed + 1024 ** 3
}

function FoldersStep({ settings, seedBytes, onPick }: { settings: Settings; seedBytes: number; onPick: (changes: SettingsPatch) => void }) {
  const pick = async (key: 'output_dir' | 'models_dir') => {
    const folder = await window.openstems.pickFolder(settings[key] || undefined)
    if (folder && folder !== settings[key]) onPick({ [key]: folder })
  }
  const outputSpace = useFolderSpace(settings.output_dir)
  const modelsSpace = useFolderSpace(settings.models_dir)
  return (
    <>
      <StepTitle title="Where should your files go?">Stems are large, so pick a drive with room. You can change both in Settings.</StepTitle>
      <div className="mt-4 flex flex-col gap-2">
        <FolderCard
          label="Stems"
          hint="A folder per song inside it."
          path={settings.output_dir}
          space={outputSpace}
          onPick={() => void pick('output_dir')}
        />
        <FolderCard
          label="Models"
          hint={seedBytes > 0 ? `The recommended models take ${formatBytes(seedBytes)}.` : 'Downloaded models are kept here.'}
          path={settings.models_dir}
          space={modelsSpace}
          warn={
            modelsFit(modelsSpace, seedBytes)
              ? undefined
              : `Not enough room on this ${words().drive} for the recommended models. Choose a folder on another one.`
          }
          onPick={() => void pick('models_dir')}
        />
      </div>
    </>
  )
}

function FolderCard({
  label,
  hint,
  path,
  space,
  warn,
  onPick,
}: {
  label: string
  hint: string
  path: string
  space: FolderSpace | null
  warn?: string
  onPick: () => void
}) {
  return (
    <div className="rounded-[10px] border border-line bg-bg px-3.5 py-3" data-testid={`welcome-folder-${label.toLowerCase()}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{label}</span>
            {space && (
              <span className="tabular text-[12px] text-faint" data-testid="free-space">
                {formatBytes(space.free)} free
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] text-muted" title={path}>
            {path}
          </div>
        </div>
        <div className="flex flex-none items-center gap-1">
          <IconButton label="Open the folder" onClick={() => void window.openstems.openFolder(path)}>
            <FolderOpen size={14} />
          </IconButton>
          <Button onClick={onPick}>Change</Button>
        </div>
      </div>
      <p className="m-0 mt-1.5 text-[12px] text-faint">{hint}</p>
      {warn && (
        <p className="m-0 mt-1.5 text-[12px] text-warn" role="alert">
          {warn}
        </p>
      )}
    </div>
  )
}

/* ---- step 2: format and how songs start ---------------------------------------- */

function FormatStep({ settings, onChange }: { settings: Settings; onChange: (changes: SettingsPatch) => void }) {
  return (
    <>
      <StepTitle title="How should stems be saved?">
        Sizes are for one stem of a four-minute song. The format can also be changed where you drop files.
      </StepTitle>
      <div className="mt-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Output format">
        {FORMATS.map((format) => {
          const checked = settings.output_format === format.value
          const noTempo = settings.tempo_sync && !carriesTempo(format.value)
          return (
            <label key={format.value} className="format-choice pressable" data-checked={checked}>
              <input
                type="radio"
                name="welcome-format"
                className="sr-only"
                value={format.value}
                checked={checked}
                onChange={() => onChange({ output_format: format.value })}
              />
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium">{format.label}</span>
                <span className="tabular flex-none text-[11.5px] text-faint">≈ {formatBytes(stemBytes(format.value, SONG_SECONDS))}</span>
              </span>
              <span className="mt-0.5 block text-[12px] text-muted">{format.description}</span>
              {noTempo && <span className="mt-1 block text-[11.5px] text-warn">FL Studio reads no tempo from it</span>}
            </label>
          )
        })}
      </div>
      <div className="mt-3 flex flex-col divide-y divide-line rounded-[10px] border border-line bg-bg px-3.5 [&>*]:py-2.5">
        <ChoiceRow
          label="Start songs as soon as they are added"
          hint="Off: songs wait in the queue until you press Start, so you can line up several first."
        >
          <Switch label="Start songs as soon as they are added" checked={settings.auto_start} onChange={(v) => onChange({ auto_start: v })} />
        </ChoiceRow>
        <ChoiceRow label="Tempo-sync for FL Studio" hint="Writes the detected tempo into WAV stems, so FL Studio can fit them to your project.">
          <Switch label="Tempo-sync for FL Studio" checked={settings.tempo_sync} onChange={(v) => onChange({ tempo_sync: v })} />
        </ChoiceRow>
      </div>
    </>
  )
}

function ChoiceRow({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="mt-0.5 text-[12px] text-muted">{hint}</div>
      </div>
      <div className="flex-none">{children}</div>
    </div>
  )
}

/* ---- step 3: the models to start with --------------------------------------------- */

function ModelsStep({ models, seed, seedBytes, settings }: { models: Model[]; seed: Model[]; seedBytes: number; settings: Settings }) {
  const machine = useMachine()
  // What the engine recommends for this machine. Where it is not the usual set, say why.
  const reason = recommendedReason(models, machine)
  if (seed.length === 0) {
    return (
      <>
        <StepTitle title="You are ready">The recommended models are already in your models folder. Drop a song to start.</StepTitle>
        <Chosen settings={settings} />
      </>
    )
  }
  return (
    <>
      <StepTitle title="Download the recommended models?">
        {`${seed.length} models, ${formatBytes(seedBytes)} in total. ${reason ?? 'They cover every standard recipe: full song, vocals, drum kit, melody and cleanup.'} You can also download models one at a time later.`}
      </StepTitle>
      <ul className="m-0 mt-4 flex max-h-[200px] list-none flex-col gap-1 overflow-y-auto p-0 text-[12.5px] text-muted">
        {seed.map((model) => (
          <li key={model.id} className="flex justify-between gap-4">
            <span className="truncate">{model.name}</span>
            <span className="tabular flex-none font-mono text-faint">{formatBytes(model.bytes)}</span>
          </li>
        ))}
      </ul>
      <Chosen settings={settings} />
    </>
  )
}

/** What the first two steps chose, read back once before the end. */
function Chosen({ settings }: { settings: Settings }) {
  const format = FORMATS.find((f) => f.value === settings.output_format)
  const rows: [string, string][] = [
    ['Stems', settings.output_dir],
    ['Format', format?.label ?? settings.output_format],
    ['New songs', settings.auto_start ? 'Start as soon as they are added' : 'Wait for Start'],
  ]
  return (
    <dl className="m-0 mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-line pt-3 text-[12.5px]" data-testid="welcome-chosen">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-faint">{term}</dt>
          <dd className="m-0 min-w-0 truncate text-muted" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
