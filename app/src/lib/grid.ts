/**
 * The beat grid and selections, as plain functions. Everything is in seconds of the song's
 * own timeline, which the song's file and every stem share (a stem whose leading silence
 * was trimmed starts later on it, at its `start`).
 *
 * Twins: `rangeLabel` names a selection as `clip_label` in
 * `engine/src/openstems/domain/grid.py` does, and `cleanDownbeat` keeps bar 1 as
 * `clean_downbeat` there does: the same arithmetic in the same order, so the clip the engine
 * writes carries the name the screen shows. The cases both must agree on are in
 * `engine/tests/fixtures/clip_labels.json`, which `src/test/trimmer.test.tsx` reads too.
 * Change both together (docs/adr/0023-trimmer.md).
 */

import type { Typed } from './tempokey'

/** A song's beat grid: its tempo, where beat 1 of bar 1 is, and the beats in a bar. */
export interface Grid {
  bpm: number
  /** Seconds from the start of the song to beat 1 of bar 1. Negative when bar 1 starts before it. */
  downbeat: number
  beatsPerBar: number
}

/** A stretch of the song, start < end, in seconds. */
export interface Range {
  start: number
  end: number
}

export type Snap = 'bar' | 'beat' | 'half' | 'quarter' | 'off'
export const SNAPS: Snap[] = ['bar', 'beat', 'half', 'quarter', 'off']
export const SNAP_LABEL: Record<Snap, string> = { bar: 'Bar', beat: 'Beat', half: '1/2', quarter: '1/4', off: 'Off' }

const MIN_BPM = 20
const MAX_BPM = 999
/** Where bar 1 may be: a minute before the song starts (a pickup), up to a day into it. */
export const MIN_DOWNBEAT = -60
export const MAX_DOWNBEAT = 86400
/** A point this close to a grid line is on it, in seconds (`EPS` in grid.py). */
const EPS = 0.0015
/** The shortest selection worth a file or a separation of its own (`MIN_SELECTION` in domain/grid.py). */
export const MIN_RANGE = 0.02

export function beatSeconds(g: Grid): number {
  return 60 / g.bpm
}

/** Beats from beat 1 of bar 1 to `t` (negative before it). */
export function beatAt(g: Grid, t: number): number {
  return (t - g.downbeat) / beatSeconds(g)
}

export function timeAtBeat(g: Grid, beat: number): number {
  return g.downbeat + beat * beatSeconds(g)
}

/** The bar `t` falls in: bar 1 starts at the downbeat, a pickup before it is bar 0. */
export function barAt(g: Grid, t: number): number {
  return Math.floor(beatAt(g, t) / g.beatsPerBar + 1e-9) + 1
}

export function timeAtBar(g: Grid, bar: number): number {
  return timeAtBeat(g, (bar - 1) * g.beatsPerBar)
}

/** The snap step in beats, or null when snapping is off. */
export function snapBeats(g: Grid, snap: Snap): number | null {
  switch (snap) {
    case 'bar':
      return g.beatsPerBar
    case 'beat':
      return 1
    case 'half':
      return 0.5
    case 'quarter':
      return 0.25
    default:
      return null
  }
}

/** The nearest grid point at this snap, or `t` itself when snapping is off. */
export function snapTime(g: Grid, t: number, snap: Snap): number {
  const step = snapBeats(g, snap)
  if (!step) return t
  return timeAtBeat(g, Math.round(beatAt(g, t) / step) * step)
}

/** The grid point at or before `t`. */
export function floorTime(g: Grid, t: number, snap: Snap): number {
  const step = snapBeats(g, snap)
  if (!step) return t
  return timeAtBeat(g, Math.floor(beatAt(g, t) / step + 1e-9) * step)
}

/** The grid point at or after `t`. */
export function ceilTime(g: Grid, t: number, snap: Snap): number {
  const step = snapBeats(g, snap)
  if (!step) return t
  return timeAtBeat(g, Math.ceil(beatAt(g, t) / step - 1e-9) * step)
}

/** Whether `t` sits on a line every `stepBeats` beats (`is_on`). */
export function isOn(g: Grid, t: number, stepBeats: number): boolean {
  const steps = beatAt(g, t) / stepBeats
  return Math.abs(steps - Math.round(steps)) * stepBeats * beatSeconds(g) < EPS
}

/** Bar, beat and sixteenth of a point, 1-based: "9.3", or "9.3.2" between beats (`format_position`). */
export function formatPosition(g: Grid, t: number): string {
  const beats = beatAt(g, t)
  const bar = Math.floor(beats / g.beatsPerBar + 1e-9) + 1
  const inBar = beats - (bar - 1) * g.beatsPerBar
  const beat = Math.floor(inBar + 1e-9) + 1
  const sixteenth = Math.floor((inBar - (beat - 1)) * 4 + 1e-6) + 1
  return sixteenth > 1 ? `${bar}.${beat}.${sixteenth}` : `${bar}.${beat}`
}

/** A point in time as m:ss.mmm, for readouts that must be exact. */
export function formatClock(t: number): string {
  const sign = t < 0 ? '-' : ''
  const ms = Math.round(Math.abs(t) * 1000)
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${sign}${m}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

/** A length in seconds, short: "22.07 s". */
function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(2)} s`
}

/** A point in time for a file name, where ":" is not allowed: "1m02.35s" (`file_time`). */
function fileTime(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100)
  const minutes = Math.floor(cs / 6000)
  const seconds = Math.floor((cs % 6000) / 100)
  return `${minutes}m${String(seconds).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}s`
}

/** Sorted, inside the song, and long enough; null when it is not a selection. */
export function cleanRange(a: number, b: number, duration: number): Range | null {
  const start = Math.max(0, Math.min(a, b))
  const end = Math.min(duration, Math.max(a, b))
  return end - start >= MIN_RANGE ? { start, end } : null
}

/**
 * A selection in a few words, for its file name and its readout: "bars 9-16" or "bar 9" when
 * both ends sit on bar lines, "9.3-11.2" when both sit on beats, times otherwise. The twin
 * of `clip_label`, digit for digit: without a grid it is always times.
 */
export function rangeLabel(g: Grid | null, r: Range): string {
  if (g) {
    if (isOn(g, r.start, g.beatsPerBar) && isOn(g, r.end, g.beatsPerBar)) {
      const first = barAt(g, r.start + EPS)
      const last = barAt(g, r.end - EPS)
      return first === last ? `bar ${first}` : `bars ${first}-${last}`
    }
    if (isOn(g, r.start, 1) && isOn(g, r.end, 1)) return `${formatPosition(g, r.start)}-${formatPosition(g, r.end)}`
  }
  return `${fileTime(r.start)}-${fileTime(r.end)}`
}

/** How long a selection is: "8 bars", "6 beats", or seconds when it is off the grid. */
export function rangeLength(g: Grid | null, r: Range): string {
  if (g && isOn(g, r.start, 1) && isOn(g, r.end, 1)) {
    const beats = Math.round((r.end - r.start) / beatSeconds(g))
    if (beats % g.beatsPerBar === 0) {
      const bars = beats / g.beatsPerBar
      return `${bars} ${bars === 1 ? 'bar' : 'bars'}`
    }
    return `${beats} ${beats === 1 ? 'beat' : 'beats'}`
  }
  return formatSeconds(r.end - r.start)
}

/* ---- changing the grid ------------------------------------------------------------- */

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i

/**
 * Where bar 1 starts as the engine keeps it, from a number or what was typed: seconds kept
 * to four decimals, or none for a blank. The twin of `clean_downbeat`: -60 to 86400
 * seconds, rounded with `Math.round(x * 10000) / 10000`.
 */
export function cleanDownbeat(value: number | string | null | undefined): Typed<number> {
  if (value === null || value === undefined) return { ok: true, value: null }
  let seconds: number
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { ok: true, value: null }
    seconds = NUMBER.test(text) ? Number(text) : Number.NaN
  } else {
    seconds = value
  }
  if (!Number.isFinite(seconds) || seconds < MIN_DOWNBEAT || seconds > MAX_DOWNBEAT) {
    return { ok: false, error: 'Bar 1 must be a time in seconds.' }
  }
  // Adding 0 turns JavaScript's -0 (a tiny negative rounded away) into Python's 0.0.
  return { ok: true, value: Math.round(seconds * 10000) / 10000 + 0 }
}

/** A tempo as the app keeps it: 20 to 999, two decimals. */
export function cleanBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm * 100) / 100))
}

export function halve(g: Grid): Grid {
  return { ...g, bpm: cleanBpm(g.bpm / 2) }
}

export function double(g: Grid): Grid {
  return { ...g, bpm: cleanBpm(g.bpm * 2) }
}

/** Bar 1 starts at `t`, kept where the engine takes it. */
export function withDownbeat(g: Grid, t: number): Grid {
  return { ...g, downbeat: Math.min(MAX_DOWNBEAT, Math.max(MIN_DOWNBEAT, t)) }
}

/** Move bar 1 by whole (or part) beats: the downbeat was another beat. */
export function shiftDownbeat(g: Grid, beats: number): Grid {
  return withDownbeat(g, g.downbeat + beats * beatSeconds(g))
}

/**
 * The two-point fit: bar 1 stays where it is and the tempo changes so that `bar` starts
 * at `t`. Not rounded, so a drag follows the pointer exactly; round with `cleanBpm` when
 * the drag ends. Returns the grid unchanged when the fit makes no sense.
 */
export function fitBar(g: Grid, bar: number, t: number): Grid {
  const beats = (bar - 1) * g.beatsPerBar
  const span = t - g.downbeat
  if (beats <= 0 || span <= 0.05) return g
  const bpm = (60 * beats) / span
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? { ...g, bpm } : g
}

/** How long after the last tap a tap tempo starts over, in milliseconds. */
export const TAP_RESET_MS = 2000

/** Tap tempo: three taps give a tempo, more taps refine it; a pause of 2 s starts over. */
export class TapTempo {
  private taps: number[] = []

  tap(nowMs: number): number | null {
    const last = this.taps[this.taps.length - 1]
    if (last !== undefined && nowMs - last > TAP_RESET_MS) this.taps = []
    this.taps.push(nowMs)
    if (this.taps.length > 8) this.taps.shift()
    if (this.taps.length < 3) return null
    const gaps = this.taps.slice(1).map((t, i) => t - (this.taps[i] ?? t))
    gaps.sort((a, b) => a - b)
    const median = gaps[Math.floor(gaps.length / 2)] ?? 0
    return median > 0 ? cleanBpm(60000 / median) : null
  }

  get count(): number {
    return this.taps.length
  }

  reset(): void {
    this.taps = []
  }
}

/* ---- drawing the grid -------------------------------------------------------------- */

export interface GridLine {
  t: number
  kind: 'bar' | 'beat' | 'sub'
  /** The bar this line is in (or starts). */
  bar: number
  /** Whether this bar line carries a number at this zoom. */
  labeled: boolean
}

/**
 * The grid lines between `t0` and `t1` that are at least `minPx` apart at
 * `pxPerSecond`. Zoomed out, beats drop away first, then every other bar line.
 */
export function gridLines(g: Grid, t0: number, t1: number, pxPerSecond: number, minPx = 6, minLabelPx = 30): GridLine[] {
  const beatPx = beatSeconds(g) * pxPerSecond
  const barPx = beatPx * g.beatsPerBar
  let step: number
  if (beatPx / 4 >= minPx) step = 0.25
  else if (beatPx / 2 >= minPx) step = 0.5
  else if (beatPx >= minPx) step = 1
  else {
    let bars = 1
    while (barPx * bars < minPx && bars < 256) bars *= 2
    step = g.beatsPerBar * bars
  }
  let labelEvery = 1
  while (barPx * labelEvery < minLabelPx && labelEvery < 256) labelEvery *= 2
  const lines: GridLine[] = []
  const first = Math.ceil(beatAt(g, t0) / step - 1e-9)
  const last = Math.floor(beatAt(g, t1) / step + 1e-9)
  for (let i = first; i <= last && lines.length < 4000; i++) {
    const beat = i * step
    const t = timeAtBeat(g, beat)
    const onBar = Math.abs(beat / g.beatsPerBar - Math.round(beat / g.beatsPerBar)) < 1e-6
    const onBeat = Math.abs(beat - Math.round(beat)) < 1e-6
    const bar = Math.floor(beat / g.beatsPerBar + 1e-9) + 1
    lines.push({
      t,
      kind: onBar ? 'bar' : onBeat ? 'beat' : 'sub',
      bar,
      labeled: onBar && (((bar - 1) % labelEvery) + labelEvery) % labelEvery === 0,
    })
  }
  return lines
}

/* ---- a view of the timeline -------------------------------------------------------- */

/** What part of the song a timeline shows. */
export interface View {
  t0: number
  t1: number
}

/** The shortest stretch a view zooms in to, in seconds. */
export const MIN_SPAN = 0.25

/** Zoom around `at` by `factor` (above 1 zooms in), kept inside the song. */
export function zoomView(v: View, at: number, factor: number, duration: number, minSpan = MIN_SPAN): View {
  const span = Math.min(duration, Math.max(minSpan, (v.t1 - v.t0) / factor))
  const ratio = (at - v.t0) / (v.t1 - v.t0)
  let t0 = at - ratio * span
  t0 = Math.min(Math.max(0, t0), duration - span)
  return { t0, t1: t0 + span }
}

/** Move the view by `dt` seconds, kept inside the song. */
export function panView(v: View, dt: number, duration: number): View {
  const span = v.t1 - v.t0
  const t0 = Math.min(Math.max(0, v.t0 + dt), Math.max(0, duration - span))
  return { t0, t1: t0 + span }
}

/** A view that shows `r` with some room around it. */
export function fitView(r: Range, duration: number, margin = 0.12): View {
  const span = Math.min(duration, (r.end - r.start) * (1 + margin * 2))
  let t0 = r.start - (span - (r.end - r.start)) / 2
  t0 = Math.min(Math.max(0, t0), Math.max(0, duration - span))
  return { t0, t1: t0 + span }
}
