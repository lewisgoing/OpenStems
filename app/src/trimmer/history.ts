/**
 * Undo and redo for the editor: what the song's grid and the part were before each change,
 * as plain functions.
 *
 * A step is the state to go back to. It is taken when a change is complete (a gesture let
 * go, a field committed, a run of nudges or taps come to rest), never while one is under
 * way, so one undo takes back one thing the user did. What is not a decision about the song
 * is not here: the zoom, the snap, what is chosen to be heard, the loop, the playhead.
 */

import type { Grid, Range } from '@/lib/grid'
import type { Figures } from './song'

/** The song as the editor has it at one moment. */
export interface Moment {
  /** The tempo and bar 1 the song is saved with (null: none of the user's, or none at all). */
  figures: Figures
  /** The grid those figures draw: shown at once when the moment comes back, before the save lands. */
  grid: Grid
  sel: Range | null
  /** The ruler had stopped explaining itself: a tempo had been fitted or typed. */
  fitted: boolean
}

/** What a step changed, for the words on the buttons: the beat grid, or the part chosen. */
export type What = 'grid' | 'part'

export interface Step {
  /** The state before the change (in `past`), or after it (in `future`). */
  moment: Moment
  what: What
  /** When it was taken, in milliseconds: steps of one run of key presses are told by it. */
  at: number
}

export interface History {
  /** Oldest first: the last is what Undo goes back to. */
  past: Step[]
  /** What Redo goes forward to, nearest last. Emptied by any new change. */
  future: Step[]
}

export const EMPTY: History = { past: [], future: [] }

/** Steps kept at most; the oldest are dropped first. */
export const KEEP = 100
/**
 * Changes of the part that follow one another within this are one step: an edge walked along
 * the bars with the arrow keys is taken back whole, not bar by bar.
 */
export const RUN_MS = 700

/**
 * The history with `before` kept as the state to go back to, for a change of `what` made at
 * `now`. Anything that had been undone can no longer be redone.
 */
export function record(history: History, before: Moment, what: What, now: number): History {
  const last = history.past[history.past.length - 1]
  if (what === 'part' && last?.what === 'part' && history.future.length === 0 && now - last.at < RUN_MS) {
    // The run goes on: it still goes back to where it began.
    return { past: [...history.past.slice(0, -1), { ...last, at: now }], future: [] }
  }
  return { past: [...history.past, { moment: before, what, at: now }].slice(-KEEP), future: [] }
}

export interface Travel {
  history: History
  /** The state to show and save. */
  to: Moment
  what: What
}

/** One step back from `current`, or null when there is nothing to undo. */
export function undo(history: History, current: Moment): Travel | null {
  const step = history.past[history.past.length - 1]
  if (!step) return null
  return {
    history: { past: history.past.slice(0, -1), future: [...history.future, { moment: current, what: step.what, at: 0 }] },
    to: step.moment,
    what: step.what,
  }
}

/** One step forward again from `current`, or null when nothing was undone. */
export function redo(history: History, current: Moment): Travel | null {
  const step = history.future[history.future.length - 1]
  if (!step) return null
  return {
    history: { past: [...history.past, { moment: current, what: step.what, at: 0 }], future: history.future.slice(0, -1) },
    to: step.moment,
    what: step.what,
  }
}

/** What the next undo or redo takes back or brings back, in words; null when there is none. */
export function nextWhat(steps: Step[]): string | null {
  const step = steps[steps.length - 1]
  if (!step) return null
  return step.what === 'grid' ? 'the beat grid' : 'the part'
}

/** Whether two parts are the same stretch of the song. */
export function sameRange(a: Range | null, b: Range | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a.start - b.start) < 1e-9 && Math.abs(a.end - b.end) < 1e-9
}

/**
 * What to save so the song has the figures `to` in place of `from`: only what differs, or
 * null when nothing does. A figure of none (null) is saved as none.
 */
export function figuresChange(from: Figures, to: Figures): { bpm?: number | null; downbeat?: number | null } | null {
  const change: { bpm?: number | null; downbeat?: number | null } = {}
  if (to.bpm !== from.bpm) change.bpm = to.bpm
  if (to.downbeat !== from.downbeat) change.downbeat = to.downbeat
  return 'bpm' in change || 'downbeat' in change ? change : null
}
