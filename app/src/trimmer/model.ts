/**
 * The editor's decisions as plain functions: what the chips choose, how a selection snaps
 * and moves, the words the readouts use, and which wheel zooms on which system. No React,
 * no DOM.
 */

import {
  type Grid,
  MAX_DOWNBEAT,
  MIN_DOWNBEAT,
  MIN_RANGE,
  type Range,
  type Snap,
  barAt,
  beatSeconds,
  ceilTime,
  cleanRange,
  floorTime,
  formatClock,
  isOn,
  rangeLabel,
  rangeLength,
  snapBeats,
  snapTime,
  timeAtBar,
} from '@/lib/grid'
import type { ClipRequest } from '@/state/clip'
import { capitalize, groupsOf, mixLabel, stemSections } from '@/state/mix'
import type { TrimSong } from './song'

/* ---- what is being trimmed ------------------------------------------------------- */

/** What the chips have chosen: the song's own file, or some (or all) of its stems. */
export type Pick = { kind: 'source' } | { kind: 'stems'; names: string[] }

export const SOURCE: Pick = { kind: 'source' }

/** One chip in the top bar. */
export type Chip = { kind: 'source' } | { kind: 'group'; group: string; parts: string[] } | { kind: 'stem'; name: string }

/** What a handle gives: the song's own file, one stem, a whole group, a mix, or every stem apart. */
export type Target =
  | { kind: 'source' }
  | { kind: 'stem'; name: string }
  | { kind: 'group'; group: string }
  | { kind: 'mix'; names: string[] }
  | { kind: 'all' }

/** The player's track for the song's own file, and for a stem. */
export const ORIGINAL = 'original'
export const stemTrack = (name: string): string => `stem:${name}`

/** The stems in their order, with the parts of a group together under it: the chips' rows. */
export function sectionsOf(song: TrimSong): { group: string | null; stems: string[] }[] {
  return stemSections(song.stems).map((section) => ({ group: section.group, stems: section.stems.map((stem) => stem.name) }))
}

const every = (song: TrimSong): string[] => song.stems.map((stem) => stem.name)

/**
 * The most stems the editor opens on together from the stems panel. Each chosen stem is
 * decoded whole, about 85 MB for four minutes, so every-stem's 13 and mega-53's 53 open on one
 * file instead, even with a few muted; every other recipe has at most 7. What the user
 * chooses by hand in the editor is not capped.
 */
export const OPEN_STEMS = 8

/**
 * What the editor shows first: the song itself, or when its own file is gone every stem (only
 * the first, past `OPEN_STEMS`).
 */
export function defaultPick(song: TrimSong): Pick {
  if (song.ownFile) return SOURCE
  const names = every(song)
  return { kind: 'stems', names: names.length > OPEN_STEMS ? names.slice(0, 1) : names }
}

/**
 * A pick kept from before, made to fit the song as it is now: the stems that are still
 * there, the song itself only while its file is. Every stem stays every stem: not every
 * recipe's stems add up to the song (drum-kit's overlap, drumless has one stem).
 */
export function validPick(song: TrimSong, pick: Pick): Pick {
  if (pick.kind === 'source') return song.ownFile ? SOURCE : defaultPick(song)
  const names = every(song).filter((name) => pick.names.includes(name))
  if (names.length === 0) return defaultPick(song)
  return { kind: 'stems', names }
}

/**
 * A chip clicked. A plain click takes that chip alone; with the shortcut key held (or Shift,
 * as for solo) it is added to what is chosen, or taken out of it. Every stem at once is a
 * mix of every stem, never the song's own file: the two differ wherever the stems do not
 * add up to the song.
 */
export function choose(song: TrimSong, pick: Pick, chip: Chip, add: boolean): Pick {
  if (chip.kind === 'source') return song.ownFile ? SOURCE : pick
  const parts = chip.kind === 'group' ? chip.parts : [chip.name]
  let names: string[]
  if (!add || pick.kind === 'source') {
    names = parts
  } else {
    const all = parts.every((part) => pick.names.includes(part))
    names = all ? pick.names.filter((name) => !parts.includes(name)) : [...pick.names, ...parts]
  }
  const order = every(song)
  names = order.filter((name) => names.includes(name))
  // The last stem cannot be taken out: there would be nothing to trim.
  if (names.length === 0) return pick
  return { kind: 'stems', names }
}

export function isChosen(pick: Pick, chip: Chip): boolean {
  if (chip.kind === 'source') return pick.kind === 'source'
  if (pick.kind === 'source') return false
  if (chip.kind === 'stem') return pick.names.includes(chip.name)
  return chip.parts.every((part) => pick.names.includes(part))
}

/** The chosen stems as a target: a stem, a whole group, or a mix. */
export function targetOf(song: TrimSong, pick: Pick): Target {
  if (pick.kind === 'source') return { kind: 'source' }
  const chosen = song.stems.filter((stem) => pick.names.includes(stem.name))
  const [first] = chosen
  if (chosen.length === 1 && first) return { kind: 'stem', name: first.name }
  const group = first?.group
  if (group && chosen.every((stem) => stem.group === group) && song.stems.filter((stem) => stem.group === group).length === chosen.length) {
    return { kind: 'group', group }
  }
  return { kind: 'mix', names: chosen.map((stem) => stem.name) }
}

/** The player's tracks that should be heard for this pick. */
export function audibleOf(pick: Pick): string[] {
  return pick.kind === 'source' ? [ORIGINAL] : pick.names.map(stemTrack)
}

/**
 * The pick that matches what solo and mute leave audible in the stems panel: those stems,
 * or every stem when nothing is soloed or muted (`null`), since the panel plays the stems,
 * not the song's own file. More than `OPEN_STEMS` open as `defaultPick` instead, however
 * they were left audible.
 */
export function pickOfAudible(song: TrimSong, audible: string[] | null): Pick {
  const names = audible === null ? every(song) : every(song).filter((name) => audible.includes(name))
  if (names.length === 0 || names.length > OPEN_STEMS) return defaultPick(song)
  return { kind: 'stems', names }
}

/**
 * The coarse peaks a pick is drawn from until it is decoded, each where its file begins in
 * the song: the song's own file at 0, a stem at its `start` (after leading silence that was
 * trimmed off it).
 */
export function peaksOf(song: TrimSong, pick: Pick, sourcePeaks: string | null): { path: string | null; start: number }[] {
  if (pick.kind === 'source') return [{ path: sourcePeaks, start: 0 }]
  return song.stems.filter((stem) => pick.names.includes(stem.name)).map((stem) => ({ path: stem.peaks, start: stem.start }))
}

/** The stems a target is made of: none for the song's own file. */
function targetStems(song: TrimSong, target: Target): string[] {
  switch (target.kind) {
    case 'source':
      return []
    case 'stem':
      return [target.name]
    case 'group':
      return song.stems.filter((stem) => stem.group === target.group).map((stem) => stem.name)
    case 'mix':
      return song.stems.filter((stem) => target.names.includes(stem.name)).map((stem) => stem.name)
    case 'all':
      return every(song)
  }
}

/** The target as the screen says it: "Original", "kick", "Drums", "Drums + bass". */
export function targetTitle(song: TrimSong, target: Target): string {
  if (target.kind === 'source') return 'Original'
  const names = targetStems(song, target)
  if (target.kind === 'all' || (names.length > 1 && names.length === song.stems.length)) return 'Every stem'
  if (names.length === 1) return names[0] ?? ''
  return capitalize(mixLabel(names, every(song), groupsOf(song.stems)))
}

/* ---- placing things on the timeline ----------------------------------------------- */

/** A point as the pointer places it: on the grid, or exactly where it is. */
export function placed(g: Grid, t: number, snap: Snap, free: boolean): number {
  return free || snap === 'off' ? t : snapTime(g, t, snap)
}

/**
 * A selection dragged from `a` to `b`. Both ends go to the nearest line; a short drag that
 * would close up on one line takes the whole step it is in, so a little drag inside a bar
 * selects that bar.
 */
export function spanned(g: Grid, a: number, b: number, snap: Snap, free: boolean, duration: number): Range | null {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (free || snap === 'off') return cleanRange(lo, hi, duration)
  let start = snapTime(g, lo, snap)
  let end = snapTime(g, hi, snap)
  if (end - start < MIN_RANGE) {
    start = floorTime(g, lo, snap)
    end = ceilTime(g, hi, snap)
  }
  if (end - start < MIN_RANGE) end = start + (snapBeats(g, snap) ?? 1) * beatSeconds(g)
  return cleanRange(start, end, duration)
}

/** A selection moved by `dt`: its length kept, the move in whole snap steps unless free. */
export function moved(g: Grid, from: Range, dt: number, snap: Snap, free: boolean, duration: number): Range {
  const step = free ? null : snapBeats(g, snap)
  const seconds = step ? step * beatSeconds(g) : 0
  const delta = seconds ? Math.round(dt / seconds) * seconds : dt
  const length = from.end - from.start
  const start = Math.min(Math.max(0, from.start + delta), Math.max(0, duration - length))
  return { start, end: start + length }
}

/** The bar a point is in, as a selection. */
export function barRange(g: Grid, t: number, duration: number): Range | null {
  const bar = barAt(g, t)
  return cleanRange(timeAtBar(g, bar), timeAtBar(g, bar + 1), duration)
}

/** How far one arrow key moves a selection's edge when snapping is off, or held free: 10 ms. */
const FINE_STEP = 0.01

/**
 * One edge of the selection moved by an arrow key: to the next grid line that way at this
 * snap, or by 10 ms when snapping is off or held free. It never crosses the other edge or
 * leaves the song; then the selection stays as it was.
 */
export function nudgeEdge(g: Grid, sel: Range, edge: 'start' | 'end', direction: -1 | 1, snap: Snap, free: boolean, duration: number): Range {
  const t = edge === 'start' ? sel.start : sel.end
  let next: number
  if (free || snap === 'off') next = t + direction * FINE_STEP
  // A millisecond past the edge first, so an edge on a line goes to the next line.
  else next = direction > 0 ? ceilTime(g, t + 0.002, snap) : floorTime(g, t - 0.002, snap)
  next = Math.min(duration, Math.max(0, next))
  const range = edge === 'start' ? { start: next, end: sel.end } : { start: sel.start, end: next }
  return range.end - range.start >= MIN_RANGE ? range : sel
}

/** Where bar 1 goes for an arrow key on its flag: 10 ms, or a beat with Shift. */
export function nudgeDownbeat(g: Grid, direction: -1 | 1, byBeat: boolean): number {
  const t = g.downbeat + direction * (byBeat ? beatSeconds(g) : FINE_STEP)
  return Math.min(MAX_DOWNBEAT, Math.max(MIN_DOWNBEAT, t))
}

/* ---- words ----------------------------------------------------------------------- */

/** Seconds as m:ss.cc, for a clock that runs. */
export function clock(t: number): string {
  const cs = Math.round(Math.max(0, t) * 100)
  const m = Math.floor(cs / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** A typed point in time: "1.689", "0:01.689", "1:02.5" or "-0:00.250". Null when it is not one. */
export function parseClock(text: string): number | null {
  const trimmed = text.trim().replace(',', '.')
  const match = /^([+-]?)(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)$/.exec(trimmed)
  if (!match) return null
  const minutes = match[2] ? Number(match[2]) : 0
  const seconds = Number(match[3])
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  const t = minutes * 60 + seconds
  return match[1] === '-' ? -t : t
}

/**
 * A selection in words for the footer: where it is, and how long. Without a grid (no tempo
 * found) it is told by its times, as its file is named.
 */
export function readout(g: Grid | null, r: Range): { where: string; length: string } {
  const seconds = `${(r.end - r.start).toFixed(2)} s`
  if (!g) return { where: `${formatClock(r.start)} to ${formatClock(r.end)}`, length: seconds }
  const label = rangeLabel(g, r)
  const onBars = isOn(g, r.start, g.beatsPerBar) && isOn(g, r.end, g.beatsPerBar)
  const onBeats = isOn(g, r.start, 1) && isOn(g, r.end, 1)
  // "9.3-11.2" says "to" between its ends; "bars -3--2" keeps its dashes.
  const where = onBars ? capitalize(label) : onBeats ? label.replace(/^(-?[\d.]+)-/, '$1 to ') : `${formatClock(r.start)} to ${formatClock(r.end)}`
  const length = rangeLength(g, r)
  return { where, length: length === seconds ? seconds : `${length} · ${seconds}` }
}

/** Whether two grids are the same grid. */
export function sameGrid(a: Grid, b: Grid): boolean {
  return Math.abs(a.bpm - b.bpm) < 1e-9 && Math.abs(a.downbeat - b.downbeat) < 1e-9 && a.beatsPerBar === b.beatsPerBar
}

/** A whole tempo close by, when the fit landed just beside one: 86.97 offers 87. */
export function wholeNear(bpm: number): number | null {
  const whole = Math.round(bpm)
  const off = Math.abs(bpm - whole)
  return off > 0.004 && off <= 0.12 ? whole : null
}

/* ---- the wheel ------------------------------------------------------------------- */

/**
 * Whether a wheel zooms rather than scrolls: Ctrl and the wheel on Windows (a touchpad pinch
 * arrives as that too); on a Mac Command and the wheel, or a trackpad pinch, which Chromium
 * reports as a wheel with Control held.
 */
export function isZoomWheel(event: { ctrlKey: boolean; metaKey: boolean }, mac: boolean): boolean {
  return mac ? event.metaKey || event.ctrlKey : event.ctrlKey
}

/**
 * How much one wheel event zooms, above 1 for in. A Mac's pinch sends many small steps, a
 * mouse wheel a few large ones: the pinch is scaled up to feel the same.
 */
export function zoomFactor(event: { deltaY: number; ctrlKey: boolean; metaKey: boolean }, mac: boolean): number {
  const pinch = mac && event.ctrlKey && !event.metaKey
  return Math.exp(-event.deltaY * (pinch ? 0.01 : 0.0025))
}

/* ---- what a handle gives --------------------------------------------------------- */

/**
 * What the engine is asked for, for a target and a selection. Without a selection: whole
 * files (the song's own file, a stem's, every stem's), or for a group or a mix one file
 * written as the stems panel writes its mix. With one: clips, of the song's own file
 * (`source`) or of stems, together in one file or (every stem) one file each. `grid` names
 * the selection; without one (no tempo found) it is named by its times.
 */
export function clipRequest(song: TrimSong, target: Target, sel: Range | null, grid: Grid | null): ClipRequest | null {
  const names = targetStems(song, target)
  const paths = song.stems.filter((stem) => names.includes(stem.name)).map((stem) => stem.path)
  if (!sel) {
    if (target.kind === 'source') return song.ownFile ? { kind: 'files', paths: [song.ownFile] } : null
    if (paths.length === 0) return null
    if (target.kind === 'all' || paths.length === 1) return { kind: 'files', paths }
    return { kind: 'mix', paths }
  }
  const stretch = {
    start: sel.start,
    end: sel.end,
    grid: grid ? { bpm: grid.bpm, downbeat: grid.downbeat, beats_per_bar: grid.beatsPerBar } : null,
  }
  if (target.kind === 'source') {
    return song.ownFile ? { kind: 'clips', clips: { ...stretch, paths: [song.ownFile], together: true, source: true } } : null
  }
  if (paths.length === 0) return null
  return { kind: 'clips', clips: { ...stretch, paths, together: target.kind !== 'all', source: false } }
}

/**
 * A clip's file name split where it may give way: the head (the song's name, as the naming
 * template puts it first) is cut first; the tail, what the file holds and its part ("drums -
 * bars 3-6.wav"), never gives way. Without the engine's `label` the tail is the part alone.
 */
export function clipNameParts(name: string, label: string, range: string): { head: string; tail: string } {
  if (!range) return { head: name, tail: '' }
  const held = label ? name.lastIndexOf(`${label} - ${range}`) : -1
  const at = held > 0 ? held : name.lastIndexOf(range)
  return at > 0 ? { head: name.slice(0, at), tail: name.slice(at) } : { head: name, tail: '' }
}

/* ---- where clips go -------------------------------------------------------------- */

/**
 * A folder split for a line that gives way in its middle: the tail, its last two folders
 * ("\full-song\Clips", or the song's "\Night Loop\Clips"), says where a clip lands and is
 * never cut.
 */
export function folderParts(folder: string): { head: string; tail: string } {
  const cuts: number[] = []
  for (let i = 0; i < folder.length; i++) if (folder[i] === '\\' || folder[i] === '/') cuts.push(i)
  const at = cuts.length >= 2 ? (cuts[cuts.length - 2] ?? -1) : -1
  return at > 0 ? { head: folder.slice(0, at), tail: folder.slice(at) } : { head: folder, tail: '' }
}

/** The separator a path already uses: a backslash on Windows, a slash on a Mac. */
function separatorOf(path: string): string {
  return path.includes('\\') ? '\\' : '/'
}

/** The folder a file is in. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut > 0 ? path.slice(0, cut) : path
}

/** A file's name without its folder or extension: the song's name in the output folder. */
function trackOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  // As `safe_component` in the engine: no character Windows forbids, no space or dot at the ends.
  return stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '') || 'untitled'
}

/**
 * Where the clips of a target are written: beside the stems for stems (`<stems>/Clips`),
 * beside the song's stem folders for its own file (`<output>/<track>/Clips`).
 */
export function clipsFolder(song: TrimSong, target: Target, outputDir: string | null): string | null {
  if (target.kind !== 'source') {
    if (!song.directory) return null
    return `${song.directory.replace(/[\\/]+$/, '')}${separatorOf(song.directory)}Clips`
  }
  if (!song.ownFile || !outputDir) return null
  const sep = separatorOf(outputDir)
  return `${outputDir.replace(/[\\/]+$/, '')}${sep}${trackOf(song.ownFile)}${sep}Clips`
}
