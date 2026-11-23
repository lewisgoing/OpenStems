import { Download } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Model, Recipe } from '@/api/client'
import { useCreateJobs, useLinkActions, useModelActions } from '@/api/queries'
import { useCurrentRecipe } from '@/components/RecipeBar'
import { useToast } from '@/components/toast'
import { Button, Dialog } from '@/components/ui'
import { formatBytes } from '@/lib/format'
import { linkFrom } from '@/lib/link'
import { toJobRequest, useSelection } from './selection'

/** Files and links that wait for the models their recipe needs. */
interface Pending {
  paths: string[]
  links: string[]
  missing: string[]
}

export interface DropFlow {
  /** What a drop will run, by name. */
  label: string
  /** Queue files as they are, or with another recipe (a rerun from History). */
  submit: (paths: string[], override?: { recipe: string }) => void
  /** Queue dropped or picked files, asking first when the recipe needs a download. */
  addPaths: (paths: string[]) => void
  addFiles: (files: File[]) => void
  /** Fetch songs from their web addresses; each is queued like a file once it is here. */
  addLinks: (urls: string[]) => void
  /** The Paste link button: take the link that is on the clipboard. */
  pasteLink: () => void
  pending: Pending | null
  setPending: (pending: Pending | null) => void
}

/**
 * From dropped files and pasted links to queued jobs, shared by the full window and the
 * quick-drop window: the current recipe, quality and options go with them, and a recipe
 * whose models are not installed holds them until they are.
 */
export function useDropFlow(recipes: Recipe[], models: Model[], onQueued?: () => void): DropFlow {
  const [pending, setPending] = useState<Pending | null>(null)
  const { selection } = useSelection()
  const { recipe, model, missing } = useCurrentRecipe(recipes, models)
  const createJobs = useCreateJobs()
  const { add: addLink } = useLinkActions()
  const toast = useToast()

  const submit = useCallback(
    (paths: string[], override?: { recipe: string }) => {
      const request = override
        ? { paths, recipe: override.recipe, quality: selection.quality }
        : toJobRequest(selection, recipe, paths)
      createJobs.mutate(request, { onSuccess: onQueued, onError: toast.error })
    },
    [createJobs, onQueued, recipe, selection, toast.error],
  )

  const submitLinks = useCallback(
    (urls: string[]) => {
      const { paths: _none, ...request } = toJobRequest(selection, recipe, [])
      for (const url of urls) addLink.mutate({ ...request, url }, { onSuccess: onQueued, onError: toast.error })
    },
    [addLink, onQueued, recipe, selection, toast.error],
  )

  const add = useCallback(
    (paths: string[], links: string[]) => {
      if (paths.length === 0 && links.length === 0) return
      if (recipe?.selectable_outputs && selection.outputs.length === 0) {
        toast.show('Pick at least one stem for this recipe first.', { kind: 'error' })
        return
      }
      if (missing.length > 0) {
        setPending({ paths, links, missing: missing.map((m) => m.id) })
        return
      }
      if (paths.length > 0) submit(paths)
      if (links.length > 0) submitLinks(links)
    },
    [missing, recipe, selection.outputs.length, submit, submitLinks, toast],
  )

  const addPaths = useCallback((paths: string[]) => add(paths, []), [add])
  const addLinks = useCallback((urls: string[]) => add([], urls), [add])
  const addFiles = useCallback((files: File[]) => addPaths(window.openstems.pathsForFiles(files)), [addPaths])

  const pasteLink = useCallback(() => {
    void window.openstems.clipboardText().then((text) => {
      const link = linkFrom(text)
      if (link) addLinks([link])
      else toast.show("Copy a song's link first, then paste it here.")
    })
  }, [addLinks, toast])

  // Once the models a pending drop needs are installed, queue it.
  useEffect(() => {
    if (!pending || pending.missing.length === 0) return
    const installed = pending.missing.every((id) => models.find((m) => m.id === id)?.status === 'installed')
    const failed = pending.missing.some((id) => {
      const state = models.find((m) => m.id === id)?.download?.state
      return state === 'failed' || state === 'cancelled'
    })
    if (installed) {
      setPending(null)
      if (pending.paths.length > 0) submit(pending.paths)
      if (pending.links.length > 0) submitLinks(pending.links)
    } else if (failed) {
      setPending(null)
    }
  }, [pending, models, submit, submitLinks])

  return {
    label: recipe?.name ?? model?.name ?? 'the selected model',
    submit,
    addPaths,
    addFiles,
    addLinks,
    pasteLink,
    pending,
    setPending,
  }
}

/**
 * Ctrl+V anywhere in the window: a copied link is fetched, copied files are queued. Text
 * fields keep their own paste.
 */
export function usePaste(flow: Pick<DropFlow, 'addFiles' | 'addLinks'>): void {
  const { addFiles, addLinks } = flow
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return
      const files = [...(event.clipboardData?.files ?? [])]
      const link = linkFrom(event.clipboardData?.getData('text/plain'))
      if (files.length === 0 && !link) return
      event.preventDefault()
      if (files.length > 0) addFiles(files)
      else if (link) addLinks([link])
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles, addLinks])
}

/** Asks before a download a drop needs, then shows it until the files can be queued. */
export function PendingDownload({ flow, models }: { flow: DropFlow; models: Model[] }) {
  const modelActions = useModelActions()
  const toast = useToast()
  const { pending, setPending } = flow
  const missingModels = pending ? pending.missing.flatMap((id) => models.find((m) => m.id === id) ?? []) : []
  const busy = missingModels.some((m) => m.download?.state === 'downloading' || m.download?.state === 'verifying')
  const what = pending && pending.paths.length === 0 ? 'link' : 'files'

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => !open && !busy && setPending(null)}
      title={busy ? 'Downloading models' : 'This recipe needs a download'}
      description={
        busy
          ? `Your ${what} will start as soon as the download finishes.`
          : `${missingModels.map((m) => m.name).join(', ')} (${formatBytes(missingModels.reduce((s, m) => s + m.bytes, 0))}). Your ${what} ${what === 'link' ? 'is' : 'are'} queued once it is installed.`
      }
      footer={
        <>
          <Button
            onClick={() => {
              for (const model of missingModels) modelActions.cancel.mutate(model.id)
              setPending(null)
            }}
          >
            Cancel
          </Button>
          {!busy && (
            <Button
              variant="primary"
              onClick={() => {
                for (const model of missingModels) modelActions.pull.mutate(model.id, { onError: toast.error })
              }}
            >
              <Download size={14} />
              Download
            </Button>
          )}
        </>
      }
    >
      {busy && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {missingModels.map((model) => {
            const fraction = model.download && model.download.total > 0 ? model.download.done / model.download.total : model.status === 'installed' ? 1 : 0
            return (
              <li key={model.id}>
                <div className="mb-1 flex justify-between text-[12px] text-muted">
                  <span>{model.name}</span>
                  <span className="tabular font-mono">{Math.round(fraction * 100)}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ transform: `scaleX(${fraction})` }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
