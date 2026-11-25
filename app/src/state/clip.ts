import { useCallback, useEffect, useRef, useState } from 'react'
import { type NewClips, useCreateClips, useCreateMix } from '@/api/queries'
import { basename } from '@/lib/format'

/**
 * The files a drag out of the trimmer hands over. A native drag needs real files before it
 * starts, so what is not on disk yet is written ahead of the drag, as a mix is (ADR 0013):
 * the engine cuts a clip once the selection has settled, and the handle says "Preparing"
 * until it has.
 */

/** What a handle gives, as the engine is asked for it. */
export type ClipRequest =
  /** Files that are there already: the song's own file, a stem, every stem. */
  | { kind: 'files'; paths: string[] }
  /** Whole stems summed into one file, written by the mixes route like the stems panel's mix. */
  | { kind: 'mix'; paths: string[] }
  /** A stretch of the song's own file or of stems, written by the clips route. */
  | { kind: 'clips'; clips: NewClips }

export interface ClipFiles {
  /**
   * `idle`: nothing asked for yet (no one reached for the handle). `preparing`: waiting for
   * the selection to settle, or the engine is writing. `ready`: `paths` can be dragged.
   * `failed`: the engine said why, in a toast; `retry` asks again.
   */
  status: 'idle' | 'preparing' | 'ready' | 'failed'
  paths: string[]
  /** The file names, as the engine wrote them. */
  names: string[]
  /**
   * What each file holds, as its name says it: a stem ("drums"), a mix ("drums + bass"), or
   * "" for the song's own file and for files that were there already.
   */
  labels: string[]
  retry: () => void
}

/** Long enough that a selection being adjusted writes one file, not one per change. */
export const SETTLE_MS = 350
/** Requests remembered at most; the oldest is forgotten first. */
const KEEP = 200

type Made = { paths: string[]; labels: string[] }

/**
 * What the engine wrote, by request, while an editor is open: coming back to a part is
 * instant. An editor opened anew forgets it (`forgetWritten`) and asks the engine again,
 * which finds a clip that is still there, writes again one that was deleted, and replaces
 * one cut from stems that were separated again since.
 */
const written = new Map<string, Made>()
/** Requests on their way, so two handles (or a remounted editor) never write the same twice. */
const pending = new Map<string, Promise<Made>>()

function keep(key: string, made: Made): void {
  written.delete(key)
  written.set(key, made)
  while (written.size > KEEP) {
    const oldest = written.keys().next().value
    if (oldest === undefined) break
    written.delete(oldest)
  }
}

/** An editor opens: what earlier editors were given may be gone from disk, or stale. */
export function forgetWritten(): void {
  written.clear()
}

/** For tests: forget every file written, and every request on its way. */
export function forgetClips(): void {
  written.clear()
  pending.clear()
}

interface Options {
  /** Ask the engine at all: false until someone reaches for a handle that writes many files. */
  wanted?: boolean
  /** No gesture is changing the request: a selection or grid being dragged writes nothing yet. */
  settled?: boolean
  onError?: (error: unknown) => void
}

type Written = { key: string; status: 'preparing' | 'ready' | 'failed' } & Made

const NOTHING: Made = { paths: [], labels: [] }

/**
 * The files for a request: files that exist at once, the rest written by the engine once the
 * request has settled for a moment (and while it is wanted). `scope` names the song (a job,
 * a stem folder), so two songs' requests for the same stretch never share a file.
 */
export function useClipFiles(scope: string, request: ClipRequest | null, { wanted = true, settled = true, onError }: Options = {}): ClipFiles {
  const clips = useCreateClips().mutateAsync
  const mix = useCreateMix().mutateAsync
  const create = useRef({ clips, mix })
  create.current = { clips, mix }
  const failed = useRef(onError)
  failed.current = onError
  const latest = useRef(request)
  latest.current = request

  const key = request && request.kind !== 'files' ? `${scope}\n${JSON.stringify(request)}` : ''
  const [state, setState] = useState<Written | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!key || !wanted || !settled) return
    const known = written.get(key)
    if (known) {
      setState({ key, status: 'ready', ...known })
      return
    }
    setState({ key, status: 'preparing', ...NOTHING })
    let stale = false
    const timer = setTimeout(() => {
      let promise = pending.get(key)
      const asked = latest.current
      if (!promise && asked && asked.kind !== 'files') {
        promise =
          asked.kind === 'mix'
            ? create.current.mix(asked.paths).then((made) => ({ paths: [made.path], labels: [''] }))
            : create.current.clips(asked.clips).then((made) => ({ paths: made.map((clip) => clip.path), labels: made.map((clip) => clip.label) }))
        pending.set(key, promise)
        promise.then(
          (made) => {
            pending.delete(key)
            keep(key, made)
          },
          () => pending.delete(key),
        )
      }
      promise?.then(
        (made) => {
          if (!stale) setState({ key, status: 'ready', ...made })
        },
        (error: unknown) => {
          if (stale) return
          setState({ key, status: 'failed', ...NOTHING })
          failed.current?.(error)
        },
      )
    }, SETTLE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [key, wanted, settled, attempt])

  const files = ({ paths, labels }: Made, status: ClipFiles['status']): ClipFiles => ({ status, paths, labels, names: paths.map(basename), retry })
  if (!request) return files(NOTHING, 'idle')
  if (request.kind === 'files') return files({ paths: request.paths, labels: request.paths.map(() => '') }, 'ready')
  const known = written.get(key)
  if (known) return files(known, 'ready')
  if (state?.key === key) return files(state, state.status)
  return files(NOTHING, wanted ? 'preparing' : 'idle')
}
