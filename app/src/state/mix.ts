import { useEffect, useRef, useState } from 'react'
import type { StemFile } from '@/api/client'
import { useCreateMix } from '@/api/queries'

/**
 * A mix in a few words: `no vocals`, `drums + bass`. The engine names the file by the same
 * rule (`mix_label` in `pipeline/mix.py`); keep the two alike.
 */
export function mixLabel(chosen: string[], every: string[]): string {
  const leftOut = every.filter((name) => !chosen.includes(name))
  if (leftOut.length === 0) return 'mix'
  if (leftOut.length === 1) return `no ${leftOut[0]}`
  if (chosen.length <= 3) return chosen.join(' + ')
  if (leftOut.length <= 3) return `no ${leftOut.join(', ')}`
  return `${chosen.length} stems`
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export interface MixFile {
  /**
   * `none`: nothing to write (no stem, one stem, or all of them: the song itself).
   * `preparing`: the engine is writing the file. `ready`: `path` can be dragged.
   */
  status: 'none' | 'preparing' | 'ready' | 'failed'
  path: string | null
}

const NONE: MixFile = { status: 'none', path: null }
const PREPARING: MixFile = { status: 'preparing', path: null }
/** Long enough that clicking through several stems writes one file, not one per click. */
const SETTLE_MS = 350

/**
 * The file for a choice of stems, written by the engine once the choice has settled. A
 * native drag needs the file to exist before it starts, so it is made ahead of the drag.
 *
 * `scope` names the stem set (a job id, a folder): files are remembered per scope, so a song
 * separated again never hands out a mix of its earlier stems.
 */
export function useMixFile(
  scope: string,
  stems: StemFile[],
  chosen: string[] | null,
  onError?: (error: unknown) => void,
): MixFile {
  const { mutateAsync } = useCreateMix()
  const create = useRef(mutateAsync)
  create.current = mutateAsync
  const failed = useRef(onError)
  failed.current = onError
  const known = useRef(new Map<string, string>())
  const [state, setState] = useState<MixFile & { key: string }>({ ...NONE, key: '' })

  const paths = chosen ? stems.filter((stem) => chosen.includes(stem.name)).map((stem) => stem.path) : []
  const wanted = paths.length >= 2 && paths.length < stems.length
  const key = wanted ? [scope, ...paths].join('\n') : ''

  useEffect(() => {
    if (!key) return
    const ready = known.current.get(key)
    if (ready) {
      setState({ key, status: 'ready', path: ready })
      return
    }
    setState({ key, status: 'preparing', path: null })
    let stale = false
    const timer = setTimeout(() => {
      create
        .current(key.split('\n').slice(1))
        .then((mix) => {
          known.current.set(key, mix.path)
          if (!stale) setState({ key, status: 'ready', path: mix.path })
        })
        .catch((error: unknown) => {
          if (stale) return
          setState({ key, status: 'failed', path: null })
          failed.current?.(error)
        })
    }, SETTLE_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [key])

  if (!key) return NONE
  return state.key === key ? state : PREPARING
}
