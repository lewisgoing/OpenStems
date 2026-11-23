import { CheckCircle2, Download, FolderOpen, Import, ShieldCheck, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { Model } from '@/api/client'
import { useModelActions, useModels } from '@/api/queries'
import { useToast } from '@/components/toast'
import { Button, Dialog, IconButton, ProgressBar, Select } from '@/components/ui'
import { cn, formatBytes, formatPercent } from '@/lib/format'

export function ModelsView() {
  const { data } = useModels()
  const actions = useModelActions()
  const toast = useToast()
  const [confirmDelete, setConfirmDelete] = useState<Model | null>(null)
  const [importing, setImporting] = useState(false)
  const models = data?.models ?? []
  const installed = models.filter((m) => m.status === 'installed')
  const available = models.filter((m) => m.status !== 'installed')
  const seedMissing = available.filter((m) => m.seed && !isBusy(m))
  const seedBytes = seedMissing.reduce((sum, m) => sum + m.bytes, 0)

  const pull = (id: string) => actions.pull.mutate(id, { onError: toast.error })

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 font-display text-[15px] font-semibold">Models</h1>
          <button
            type="button"
            className="pressable mt-0.5 flex max-w-full items-center gap-1.5 border-0 bg-transparent p-0 text-[12px] text-muted"
            title="Open the models folder"
            onClick={() => data && void window.openstems.openFolder(data.models_dir)}
          >
            <FolderOpen size={12} className="flex-none" />
            <span className="truncate">{data?.models_dir}</span>
            <span className="tabular flex-none text-faint">· {formatBytes(data?.installed_bytes ?? 0)} installed</span>
          </button>
        </div>
        <Button onClick={() => setImporting(true)}>
          <Import size={14} />
          Import
        </Button>
        {seedMissing.length > 0 && (
          <Button variant="primary" onClick={() => seedMissing.forEach((m) => pull(m.id))}>
            <Download size={14} />
            Download recommended ({formatBytes(seedBytes)})
          </Button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <Section title="Installed" count={installed.length}>
          {installed.length === 0 && (
            <p className="m-0 px-3 py-4 text-muted">Nothing installed yet. Download the recommended set to run every standard recipe.</p>
          )}
          {installed.map((model) => (
            <ModelRow key={model.id} model={model}>
              <IconButton label="Verify files" onClick={() => actions.verify.mutate(model.id, {
                onSuccess: (result) => toast.show(result.ok ? `${model.name}: files verified` : `${model.name}: ${result.problems.join('; ')}`, { kind: result.ok ? 'info' : 'error' }),
                onError: toast.error,
              })}>
                <ShieldCheck size={14} />
              </IconButton>
              <IconButton label="Delete" onClick={() => setConfirmDelete(model)}>
                <Trash2 size={14} />
              </IconButton>
            </ModelRow>
          ))}
        </Section>

        <Section title="Available" count={available.length}>
          {available.map((model) => (
            <ModelRow key={model.id} model={model}>
              {isBusy(model) ? (
                <IconButton label="Cancel download" onClick={() => actions.cancel.mutate(model.id, { onError: toast.error })}>
                  <X size={14} />
                </IconButton>
              ) : (
                <Button size="sm" onClick={() => pull(model.id)}>
                  <Download size={13} />
                  {model.status === 'partial' ? 'Resume' : formatBytes(model.bytes)}
                </Button>
              )}
            </ModelRow>
          ))}
        </Section>
      </div>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        description={
          <>
            This removes {formatBytes(confirmDelete?.bytes ?? 0)} of model files.
            {confirmDelete && confirmDelete.used_by.length > 0 && ` Recipes that need it: ${confirmDelete.used_by.join(', ')}.`}
            {confirmDelete?.custom ? ' An imported model cannot be downloaded again.' : ' You can download it again later.'}
          </>
        }
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Keep</Button>
            <Button
              variant="danger"
              className="!border-danger/40"
              onClick={() => {
                if (confirmDelete) actions.remove.mutate(confirmDelete.id, { onError: toast.error })
                setConfirmDelete(null)
              }}
            >
              Delete
            </Button>
          </>
        }
      />
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  )
}

function isBusy(model: Model): boolean {
  return model.download?.state === 'downloading' || model.download?.state === 'verifying'
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h2 className="m-0 px-3 pb-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">
        {title} <span className="tabular ml-1 font-normal text-faint">{count}</span>
      </h2>
      <ul className="m-0 list-none p-0">{children}</ul>
    </section>
  )
}

function ModelRow({ model, children }: { model: Model; children: React.ReactNode }) {
  const download = model.download
  const busy = isBusy(model)
  const fraction = download && download.total > 0 ? download.done / download.total : 0
  return (
    <li
      data-testid="model-row"
      className="group/row row-hover rounded-[10px] px-3 py-2.5"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {model.status === 'installed' && <CheckCircle2 size={13} className="flex-none text-ok" />}
            <span className="truncate font-medium">{model.name}</span>
            {model.seed && <span className="chip">recommended</span>}
            {model.experimental && <span className="chip !text-warn">experimental</span>}
            {model.custom && <span className="chip">imported</span>}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">
            {model.stems.length > 8 ? `${model.stems.length} stems` : model.stems.join(', ')}
            <span className="text-faint"> · {formatBytes(model.bytes)} · license: {model.license}</span>
          </div>
          {download?.state === 'failed' && (
            <div className={cn('mt-0.5 truncate text-[12px] text-danger')} role="alert">
              {download.error}
            </div>
          )}
        </div>
        {busy && (
          <span className="tabular flex-none font-mono text-[12px] text-muted">
            {download?.state === 'verifying' ? 'Verifying' : formatPercent(fraction)}
          </span>
        )}
        <div className="flex flex-none items-center gap-0.5">{children}</div>
      </div>
      {busy && (
        <div className="mt-2">
          <ProgressBar value={fraction} indeterminate={download?.state === 'verifying'} />
        </div>
      )}
    </li>
  )
}

const ARCHITECTURES = [
  { value: 'bs_roformer', label: 'BS-RoFormer' },
  { value: 'mel_band_roformer', label: 'Mel-Band RoFormer' },
  { value: 'mdx23c', label: 'MDX23C' },
]

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const actions = useModelActions()
  const toast = useToast()
  const [checkpoint, setCheckpoint] = useState('')
  const [config, setConfig] = useState('')
  const [architecture, setArchitecture] = useState('bs_roformer')
  const [agreed, setAgreed] = useState(false)
  const ready = checkpoint && config && agreed && !actions.importModel.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Import a model"
      description="Add a checkpoint you already have. It is copied into the models folder and hashed."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() =>
              actions.importModel.mutate(
                { checkpoint, config, architecture: architecture as 'bs_roformer' | 'mel_band_roformer' | 'mdx23c' },
                {
                  onSuccess: (model) => {
                    toast.show(`Imported ${model.name}`)
                    setCheckpoint('')
                    setConfig('')
                    setAgreed(false)
                    onClose()
                  },
                  onError: toast.error,
                },
              )
            }
          >
            Import
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <PathField label="Checkpoint" value={checkpoint} placeholder="model.ckpt" onPick={async () => setCheckpoint((await window.openstems.pickFile({ title: 'Checkpoint', extensions: ['ckpt', 'pth', 'pt'] })) ?? checkpoint)} />
        <PathField label="Config" value={config} placeholder="config.yaml" onPick={async () => setConfig((await window.openstems.pickFile({ title: 'Config', extensions: ['yaml', 'yml'] })) ?? config)} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted">Architecture</span>
          <Select label="Architecture" value={architecture} options={ARCHITECTURES} onChange={setArchitecture} className="min-w-[200px]" />
        </div>
        <label className="flex items-start gap-2.5 rounded-[8px] border border-warn/30 bg-warn/5 p-3 text-[12.5px]">
          <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
          <span>
            Checkpoints are pickles: a malicious file can run code when it is loaded. OpenStems loads with
            weights-only mode, which blocks that, but only import checkpoints from a source you trust.
          </span>
        </label>
      </div>
    </Dialog>
  )
}

function PathField({ label, value, placeholder, onPick }: { label: string; value: string; placeholder: string; onPick: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[76px] flex-none text-muted">{label}</span>
      <span className={cn('input flex min-w-0 flex-1 items-center truncate', !value && 'text-faint')} title={value}>
        <span className="truncate">{value || placeholder}</span>
      </span>
      <Button onClick={onPick}>Browse</Button>
    </div>
  )
}
