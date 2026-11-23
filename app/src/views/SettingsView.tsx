import { FolderOpen } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { SetupStatus, ShellStatus, TorchVariant } from '../../electron/bridge'
import { VARIANTS, VARIANT_CARDS, VARIANT_DOWNLOAD, VARIANT_LABEL } from '../../electron/variant'
import type { Recipe, Settings, SettingsPatch } from '@/api/client'
import { useMaintenance, usePatchSettings, useSettings, useSystem } from '@/api/queries'
import { FORMATS } from '@/components/FormatSelect'
import { useToast } from '@/components/toast'
import { UpdateSettings } from '@/components/Update'
import { Button, CommitInput, Dialog, IconButton, Segmented, Select, Switch } from '@/components/ui'
import { cn, previewName } from '@/lib/format'

const QUALITY = [
  { value: 'fast' as const, label: 'Fast' },
  { value: 'balanced' as const, label: 'Balanced' },
  { value: 'best' as const, label: 'Best' },
]
const TOKENS = ['{track}', '{stem}', '{recipe}', '{bpm}', '{key}']

export function SettingsView({ recipes }: { recipes: Recipe[] }) {
  const { data: settings } = useSettings()
  const { data: system } = useSystem()
  const patch = usePatchSettings()
  const maintenance = useMaintenance()
  const toast = useToast()
  if (!settings) return null

  const save = (changes: SettingsPatch) => patch.mutate(changes, { onError: toast.error })
  const pickFolder = async (key: 'output_dir' | 'models_dir' | 'watch_folder') => {
    const folder = await window.openstems.pickFolder(settings[key] || undefined)
    if (folder) save({ [key]: folder })
  }
  const example = previewName(settings.naming_template, { track: 'My Song', stem: 'vocals', recipe: 'full-song', bpm: '128', key: 'Am' })

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line px-5 py-3">
        <h1 className="m-0 font-display text-[15px] font-semibold">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-[720px] flex-col gap-6">
          <Group title="Folders">
            <FolderRow label="Output folder" hint="One folder per track and recipe." value={settings.output_dir} onPick={() => pickFolder('output_dir')} />
            <FolderRow label="Models folder" hint="Downloaded weights. Uninstalling the app leaves it alone." value={settings.models_dir} onPick={() => pickFolder('models_dir')} />
          </Group>

          <Group title="Output">
            <Row label="Format" hint="Stems are 44.1 kHz stereo, the rate the models run at. Also on the bar where you drop files.">
              <Select label="Output format" value={settings.output_format} options={FORMATS} onChange={(v) => save({ output_format: v as Settings['output_format'] })} className="min-w-[200px]" minWidth={300} />
            </Row>
            <Row label="Match the source sample rate" hint="Resample stems back to the source's rate, for example 48 kHz.">
              <Switch label="Match the source sample rate" checked={settings.match_source_rate} onChange={(v) => save({ match_source_rate: v })} />
            </Row>
            <Row label="File names" hint={<>Example: <span className="font-mono text-text">{example}.wav</span></>}>
              <div className="flex flex-col items-end gap-1.5">
                <CommitInput aria-label="Naming template" className="w-[260px] font-mono text-[12px]" value={settings.naming_template} onCommit={(v) => save({ naming_template: v })} />
                <div className="flex gap-1">
                  {TOKENS.map((token) => (
                    <button
                      key={token}
                      type="button"
                      className="chip pressable font-mono"
                      title={`Add ${token}`}
                      onClick={() => save({ naming_template: `${settings.naming_template} ${token}`.trim() })}
                    >
                      {token}
                    </button>
                  ))}
                </div>
              </div>
            </Row>
            <Row label="Trim silence" hint="Cut leading and trailing silence per stem. Stems then no longer line up at bar 1.">
              <Switch label="Trim silence" checked={settings.trim_silence} onChange={(v) => save({ trim_silence: v })} />
            </Row>
            <Row label="Normalize" hint="Raise each stem to -1 dBFS peak. Off by default: stems keep their level in the mix.">
              <Switch label="Normalize" checked={settings.normalize} onChange={(v) => save({ normalize: v })} />
            </Row>
            <Row label="Detect tempo and key" hint="Fills the {bpm} and {key} tokens and shows them with the stems.">
              <Switch label="Detect tempo and key" checked={settings.detect_tempo_key} onChange={(v) => save({ detect_tempo_key: v })} />
            </Row>
            <Row label="Write MIDI" hint="A draggable .mid next to vocal, bass and melody stems. Monophonic: one note at a time.">
              <Switch label="Write MIDI" checked={settings.write_midi} onChange={(v) => save({ write_midi: v })} />
            </Row>
          </Group>

          <Group title="Queue">
            <Row
              label="Start songs automatically"
              hint="Off: songs you add wait in the queue until you press Start, so you can line up several and set the order first. On: each song starts as soon as it is added. The watch folder always starts its files."
            >
              <Switch label="Start songs automatically" checked={settings.auto_start} onChange={(v) => save({ auto_start: v })} />
            </Row>
          </Group>

          <Group title="Defaults">
            <Row label="Recipe" hint="Used by the watch folder and by a fresh install.">
              <Select
                label="Default recipe"
                value={settings.default_recipe}
                options={recipes.filter((r) => !r.selectable_outputs).map((r) => ({ value: r.id, label: r.name }))}
                onChange={(v) => save({ default_recipe: v })}
                className="min-w-[200px]"
              />
            </Row>
            <Row label="Quality">
              <Segmented label="Default quality" value={settings.default_quality} options={QUALITY} onChange={(v) => save({ default_quality: v })} />
            </Row>
            <Row label="Sum to mix" hint="Fold the residual into 'other' so the stems sum back to the mix.">
              <Switch label="Sum to mix by default" checked={settings.sum_to_mix} onChange={(v) => save({ sum_to_mix: v })} />
            </Row>
          </Group>

          <Group title="Watch folder">
            <Row label="Queue new files automatically" hint="Files that appear in the folder run with the default recipe and quality.">
              <Switch label="Watch folder" checked={settings.watch_enabled} disabled={!settings.watch_folder} onChange={(v) => save({ watch_enabled: v })} />
            </Row>
            <FolderRow label="Folder" value={settings.watch_folder} placeholder="Not set" onPick={() => pickFolder('watch_folder')} />
          </Group>

          <TraySettings />

          <Group title="Updates">
            <UpdateSettings Row={Row} />
          </Group>

          <Group title="System">
            <Row label="GPU" hint={system ? gpuHint(system) : undefined}>
              <span className="text-muted">
                {system ? (system.gpu_name ?? 'None found') : 'Checking'}
                {system?.vram_gb ? ` · ${system.vram_gb.toFixed(1)} GB` : ''}
              </span>
            </Row>
            <Row
              label="Use the GPU"
              hint="Off runs separation on the CPU: much slower, but a way through when the graphics card or its driver misbehaves."
            >
              <Switch label="Use the GPU" checked={settings.use_gpu} onChange={(v) => save({ use_gpu: v })} />
            </Row>
            <EngineBuildRow />
            <Row label="GPU self-test" hint="Runs the same work on the GPU and on the CPU and compares the results. Takes a minute or two.">
              <Button
                disabled={maintenance.selfTest.isPending}
                onClick={() => maintenance.selfTest.mutate(undefined, { onError: toast.error })}
              >
                {maintenance.selfTest.isPending && <span className="spinner" />}
                {maintenance.selfTest.isPending ? 'Testing' : 'Run'}
              </Button>
            </Row>
            {maintenance.selfTest.data && !maintenance.selfTest.isPending && <SelfTestResult report={maintenance.selfTest.data} />}
            {system?.problems.map((problem) => (
              <p key={problem} className="m-0 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-danger" role="alert">
                {problem}
              </p>
            ))}
            <Row label="Diagnostics" hint="A zip with system info, settings and logs. No audio, no weights.">
              <Button
                disabled={maintenance.exportDiagnostics.isPending}
                onClick={() =>
                  maintenance.exportDiagnostics.mutate(undefined, {
                    onSuccess: ({ path }) => {
                      toast.show('Diagnostics exported', { action: { label: 'Show', run: () => void window.openstems.revealInExplorer(path) } })
                    },
                    onError: toast.error,
                  })
                }
              >
                Export diagnostics
              </Button>
            </Row>
            <Row label="History index" hint="Rebuilt from the manifests in the output folder. Files are never touched.">
              <Button
                disabled={maintenance.rebuildIndex.isPending}
                onClick={() =>
                  maintenance.rebuildIndex.mutate(undefined, {
                    onSuccess: (result) => toast.show(`Indexed ${result.stem_sets} stem sets`),
                    onError: toast.error,
                  })
                }
              >
                Rebuild
              </Button>
            </Row>
            <Row label="Logs">
              <Button variant="ghost" onClick={() => system && void window.openstems.openFolder(system.logs_dir)}>
                Open the logs folder
              </Button>
            </Row>
            <p className="m-0 text-[12px] text-faint">
              OpenStems {window.openstems.info.version} · engine {system?.version}
            </p>
          </Group>
        </div>
      </div>
    </div>
  )
}

interface SelfTestReport {
  ok: boolean
  gpu_available?: boolean
  ops?: { name: string; ok: boolean; detail?: string }[]
  models?: { id: string; ok: boolean; detail?: string; gpu_seconds?: number | null; cpu_seconds?: number | null }[]
  problems?: string[]
}

/** The self-test in a few lines: what passed, and each thing that did not, by name. */
export function selfTestLines(report: SelfTestReport): string[] {
  const ops = report.ops ?? []
  const models = report.models ?? []
  const lines: string[] = [...(report.problems ?? [])]
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  if (ops.length > 0) {
    const failed = ops.filter((op) => !op.ok)
    lines.push(
      failed.length === 0
        ? `All ${count(ops.length, 'operation')} match the CPU.`
        : `${failed.length} of ${count(ops.length, 'operation')} failed: ${failed.map((op) => op.name).join(', ')}.`,
    )
  }
  for (const model of models) {
    if (!model.ok) {
      lines.push(`${model.id} failed: ${model.detail || 'the GPU and the CPU disagree'}.`)
    } else if (model.gpu_seconds && model.cpu_seconds) {
      const faster = model.cpu_seconds / model.gpu_seconds
      lines.push(`${model.id} matches the CPU and runs ${faster >= 10 ? Math.round(faster) : faster.toFixed(1)} times faster on the GPU.`)
    } else {
      lines.push(`${model.id} matches the CPU.`)
    }
  }
  return lines
}

function SelfTestResult({ report }: { report: SelfTestReport }) {
  return (
    <div
      role="status"
      className={cn('rounded-[8px] border px-3 py-2', report.ok ? 'border-line text-muted' : 'border-danger/30 bg-danger/10 text-danger')}
    >
      <p className="m-0 font-medium">{report.ok ? 'The GPU passed.' : 'The GPU self-test found a problem.'}</p>
      <ul className="m-0 mt-1 list-none p-0">
        {selfTestLines(report).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {!report.ok && <p className="m-0 mt-1">Export diagnostics includes this result.</p>}
    </div>
  )
}

interface GpuFacts {
  torch?: string | null
  cuda_available: boolean
  gpu_backend?: string | null
  gpu_backend_version?: string | null
  fake_engine: boolean
}

/** What the GPU row says under the card's name: the PyTorch build, or that the CPU is in use. */
export function gpuHint(system: GpuFacts): string | undefined {
  if (system.fake_engine) return undefined
  const backend = system.gpu_backend === 'rocm' ? 'ROCm' : system.gpu_backend === 'cuda' ? 'CUDA' : null
  const version = system.gpu_backend_version ? ` ${system.gpu_backend_version}` : ''
  const build = `PyTorch ${system.torch ?? 'missing'}${backend ? `, ${backend}${version}` : ''}`
  return system.cuda_available ? build : `${build}. Running on the CPU.`
}

/**
 * Packaged builds only: which PyTorch build the engine environment holds, and a way to
 * swap it (a new graphics card, or the detection picked the wrong one).
 */
export function EngineBuildRow() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  // The build picked in the list, until the switch is confirmed or called off.
  const [target, setTarget] = useState<TorchVariant | null>(null)
  useEffect(() => {
    let live = true
    void window.openstems.detectGpu().then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
  }, [])
  if (!status?.managed || !status.installed) return null
  const installed = status.installed
  const other = target ?? installed
  const fits = status.recommended === undefined || status.recommended === installed
  const hint = `PyTorch for ${VARIANT_LABEL[installed]} graphics cards.${fits ? '' : ` ${status.note}`}`
  return (
    <>
      <Row label="Engine build" hint={hint}>
        <Select
          label="Engine build"
          value={installed}
          options={VARIANTS.map((value) => ({ value, label: VARIANT_LABEL[value], description: VARIANT_CARDS[value] }))}
          onChange={(value) => value !== installed && setTarget(value as TorchVariant)}
          className="min-w-[170px]"
          minWidth={300}
        />
      </Row>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`Switch the engine to ${VARIANT_LABEL[other]}?`}
        description={`This rebuilds the engine's Python environment and downloads ${VARIANT_DOWNLOAD[other]}. Running jobs stop. Your models, stems and settings are not touched.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setTarget(null)
                void window.openstems.switchBuild(other)
              }}
            >
              Switch and download
            </Button>
          </>
        }
      />
    </>
  )
}

/**
 * How the app lives in the tray. These belong to the shell, not to the engine, so they are
 * read from and saved by the main process.
 */
export function TraySettings() {
  const [status, setStatus] = useState<ShellStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.openstems.shellStatus().then((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
    }
  }, [])
  if (!status) return null
  const change = (patch: Partial<Pick<ShellStatus, 'closeToTray' | 'startAtLogin' | 'checkForUpdates' | 'notifyReady'>>) => {
    // The switch moves at once; the main process then says what was actually set.
    setStatus({ ...status, ...patch })
    void window.openstems.setShell(patch).then(setStatus)
  }
  return (
    <Group title="Tray">
      <Row
        label="Keep running in the tray"
        hint="Closing the window leaves OpenStems by the clock with the engine ready. Click its icon to drop a song, right-click it to quit."
      >
        <Switch label="Keep running in the tray" checked={status.closeToTray} onChange={(v) => change({ closeToTray: v })} />
      </Row>
      <Row label="Tell me when stems are ready" hint="A Windows notification when songs finish while OpenStems is out of sight. Clicking it opens the quick-drop window.">
        <Switch label="Tell me when stems are ready" checked={status.notifyReady} onChange={(v) => change({ notifyReady: v })} />
      </Row>
      {status.canStartAtLogin && (
        <Row label="Start with Windows" hint="Starts in the tray, without opening a window.">
          <Switch label="Start with Windows" checked={status.startAtLogin} onChange={(v) => change({ startAtLogin: v })} />
        </Row>
      )}
    </Group>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="m-0 mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
      <div className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface px-4 [&>*]:py-3">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  )
}

function FolderRow({ label, hint, value, placeholder, onPick }: { label: string; hint?: string; value: string; placeholder?: string; onPick: () => void }) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="mt-0.5 truncate font-mono text-[12px] text-muted" title={value}>
          {value || placeholder}
        </div>
        {hint && <div className="mt-0.5 text-[12px] text-faint">{hint}</div>}
      </div>
      <div className="flex flex-none items-center gap-1">
        {value && (
          <IconButton label="Open the folder" onClick={() => void window.openstems.openFolder(value)}>
            <FolderOpen size={14} />
          </IconButton>
        )}
        <Button onClick={onPick}>Change</Button>
      </div>
    </div>
  )
}
