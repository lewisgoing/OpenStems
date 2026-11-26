/**
 * What the editor remembers of each song for the rest of the session: what was chosen in
 * it, the selection, the snap, the view, and whether the tempo was fitted. Opening the song
 * again shows it as it was left. Nothing here is saved to disk.
 */

import type { Range, Snap, View } from '@/lib/grid'
import type { History } from './history'
import type { Pick } from './model'

export interface TrimMemory {
  pick: Pick | null
  sel: Range | null
  snap: Snap
  view: View | null
  /** A bar line was dragged onto its beat (or the tempo typed): the ruler stops explaining. */
  fitted: boolean
  /**
   * Where the timeline `sel` and `view` are on starts in the whole song (`TrimSong.origin`):
   * a waiting song's part comes back as stems whose 0 is the part's start.
   */
  origin: number
  /** What can be undone and redone, so a song left and opened again can still be put right. */
  history?: History
}

export const FRESH: TrimMemory = { pick: null, sel: null, snap: 'bar', view: null, fitted: false, origin: 0 }

/** Songs remembered at most; the oldest is forgotten first. */
const KEEP = 50
const kept = new Map<string, TrimMemory>()

/** What the editor last left this song as, or a fresh start. */
export function recall(id: string): TrimMemory {
  return kept.get(id) ?? FRESH
}

export function remember(id: string, memory: TrimMemory): void {
  kept.delete(id)
  kept.set(id, memory)
  while (kept.size > KEEP) {
    const oldest = kept.keys().next().value
    if (oldest === undefined) break
    kept.delete(oldest)
  }
}

/** For tests: forget every song. */
export function forgetAll(): void {
  kept.clear()
}
