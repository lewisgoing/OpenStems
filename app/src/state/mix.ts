import { useEffect, useRef, useState } from 'react'
import type { StemFile } from '@/api/client'
import { useCreateMix } from '@/api/queries'

/**
 * A mix in a few words: `no vocals`, `drums + bass`, `drums no kick`. The engine names the
 * file by the same rule (`mix_label` in `pipeline/mix.py`); keep the two alike.
 */
export function mixLabel(chosen: string[], every: string[], groups: Record<string, string> = {}): string {
  const picked = chosen
  const count = chosen.length
  let leftOut = every.filter((name) => !chosen.includes(name))
  // A group that is all in, or all out, goes by its own name: the whole kit is "drums".
  chosen = wholeGroups(chosen, every, groups)
  leftOut = wholeGroups(leftOut, every, groups)
  if (chosen.length === 1 && leftOut.length > 0) return chosen[0] ?? ''
  if (leftOut.length === 0) return 'mix'
  if (leftOut.length === 1) return `no ${leftOut[0]}`
  if (chosen.length <= 3) return chosen.join(' + ')
  if (leftOut.length <= 3) return `no ${leftOut.join(', ')}`
  return groupWithout(picked, every, groups) ?? `${count} stems`
}

/** "drums no kick": every stem chosen is a part of one group, and only a few of its parts are left out. */
function groupWithout(picked: string[], every: string[], groups: Record<string, string>): string | null {
  const group = groups[picked[0] ?? '']
  if (!group || picked.some((name) => groups[name] !== group)) return null
  const missing = every.filter((name) => groups[name] === group && !picked.includes(name))
  return missing.length > 0 && missing.length <= 3 ? `${group} no ${missing.join(', ')}` : null
}

/** `names` with every group that is all there replaced by the group's name. */
function wholeGroups(names: string[], every: string[], groups: Record<string, string>): string[] {
  const out: string[] = []
  for (const name of names) {
    const group = groups[name]
    if (group && every.every((other) => groups[other] !== group || names.includes(other))) {
      if (!out.includes(group)) out.push(group)
    } else {
      out.push(name)
    }
  }
  return out
}

/** The group of each stem that is a part of a larger one (kick in drums). */
export function groupsOf(stems: { name: string; group?: string | null }[]): Record<string, string> {
  const groups: Record<string, string> = {}
  for (const stem of stems) if (stem.group) groups[stem.name] = stem.group
  return groups
}

export interface StemSection<T> {
  /** The larger stem these are the parts of, or null for a stem on its own. */
  group: string | null
  stems: T[]
}

/** Stems in their own order, with the parts of one group that follow each other together. */
export function stemSections<T extends { group?: string | null }>(stems: T[]): StemSection<T>[] {
  const sections: StemSection<T>[] = []
  for (const stem of stems) {
    const last = sections[sections.length - 1]
    if (stem.group && last?.group === stem.group) last.stems.push(stem)
    else sections.push({ group: stem.group || null, stems: [stem] })
  }
  return sections
}

/** A part's name inside its group: "lead vocals" under Vocals is "lead". */
export function partName(name: string, group: string | null | undefined): string {
  if (!group) return name
  const lower = name.toLowerCase()
  const tail = ` ${group.toLowerCase()}`
  return lower.endsWith(tail) && name.length > tail.length ? name.slice(0, -tail.length) : name
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
