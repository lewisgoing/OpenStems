/**
 * Empty stems: the engine marks a stem `empty` when it holds nothing but what the model let
 * through (the guitar of a song without one; `domain/levels.py` has the rule). With the
 * "Hide empty stems" setting on, a song's lists leave them out behind a line that brings
 * them back. Nothing here touches a file: every stem is written either way.
 */

export interface Split<T> {
  /** What a list shows, in the stems' own order. */
  shown: T[]
  /** The empty stems left out of it. */
  hidden: T[]
}

/**
 * A song's stems, split into the ones a list shows and the empty ones it leaves out.
 * Nothing is left out with `hide` off, and nothing when every stem is empty: a list of
 * nothing would say less than six flat lines do.
 */
export function splitEmpty<T extends { empty?: boolean }>(stems: T[], hide: boolean): Split<T> {
  if (!hide) return { shown: stems, hidden: [] }
  const hidden = stems.filter((stem) => stem.empty)
  if (hidden.length === 0 || hidden.length === stems.length) return { shown: stems, hidden: [] }
  return { shown: stems.filter((stem) => !stem.empty), hidden }
}

/** "1 stem", "6 stems". */
export function stemCount(count: number): string {
  return `${count} ${count === 1 ? 'stem' : 'stems'}`
}

/** What a "drag all" handle says it carries, given how many empty stems it leaves behind. */
export function dragAllHint(shown: number, hidden: number): string {
  if (hidden === 0) return 'Drag every stem into your DAW or a folder'
  const carried = shown === 1 ? 'the one stem with sound' : `the ${shown} stems with sound`
  return `Drag ${carried} into your DAW or a folder. ${hidden} empty ${hidden === 1 ? 'one stays' : 'ones stay'} behind`
}
