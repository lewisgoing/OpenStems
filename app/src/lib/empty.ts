/**
 * Stems a song's lists leave out. The engine marks a stem `empty` when it holds nothing but
 * what the model let through (the guitar of a song without one; `domain/levels.py` has the
 * rule), and with the "Hide empty stems" setting on the lists leave those out behind a line
 * that brings them back. The user can also decide for one stem: `hidden` true leaves it out
 * whatever the setting, false keeps it in though it is empty. That choice is kept with the
 * song, in its manifest. Nothing here touches a file: every stem is written either way.
 */

/** What decides whether a stem is in a list: the engine's verdict and the user's own. */
export interface Marked {
  empty?: boolean
  hidden?: boolean | null
}

export interface Split<T> {
  /** What a list shows, in the stems' own order. */
  shown: T[]
  /** The stems left out of it: the empty ones, and the ones the user hid. */
  hidden: T[]
}

/** Whether a list leaves this stem out: the user's choice if there is one, else the setting. */
export function isLeftOut(stem: Marked, hide: boolean): boolean {
  if (typeof stem.hidden === 'boolean') return stem.hidden
  return hide && Boolean(stem.empty)
}

/**
 * A song's stems, split into the ones a list shows and the ones it leaves out. `hide` is the
 * "Hide empty stems" setting. Nothing is left out when every stem would be: a list of nothing
 * would say less than six flat lines do.
 */
export function splitEmpty<T extends Marked>(stems: T[], hide: boolean): Split<T> {
  const hidden = stems.filter((stem) => isLeftOut(stem, hide))
  if (hidden.length === 0 || hidden.length === stems.length) return { shown: stems, hidden: [] }
  return { shown: stems.filter((stem) => !isLeftOut(stem, hide)), hidden }
}

/**
 * What a click on a stem's hide button stores: the other side of where the stem is now. Only
 * a choice that differs from what the setting would do is kept (`null` takes one away), so a
 * stem follows the setting again once it is put back where the setting has it.
 */
export function hideChoice(stem: Marked, hide: boolean): boolean | null {
  const auto = hide && Boolean(stem.empty)
  if (isLeftOut(stem, hide)) return auto ? false : null
  return auto ? null : true
}

/** What the left-out stems are called together: "empty" unless the user hid one of them. */
export function leftOutWord(hidden: Marked[]): 'empty' | 'hidden' {
  return hidden.some((stem) => stem.hidden === true) ? 'hidden' : 'empty'
}

/** "1 stem", "6 stems". */
export function stemCount(count: number): string {
  return `${count} ${count === 1 ? 'stem' : 'stems'}`
}

/** What a "drag all" handle says it carries, given how many stems it leaves behind and why. */
export function dragAllHint(shown: number, hidden: number, word: 'empty' | 'hidden' = 'empty'): string {
  if (hidden === 0) return 'Drag every stem into your DAW or a folder'
  const what = word === 'empty' ? 'with sound' : 'shown'
  const carried = shown === 1 ? `the one stem ${what}` : `the ${shown} stems ${what}`
  return `Drag ${carried} into your DAW or a folder. ${hidden} ${word} ${hidden === 1 ? 'one stays' : 'ones stay'} behind`
}
