/**
 * The song the editor trims, built from what the engine says: a job in the queue (waiting to
 * start, or separated) or a stem set from the History. Plain functions, no React.
 *
 * One tempo per song: the grid is the song's own tempo and bar 1, set with the same retag as
 * the tempo field (ADR 0019, ADR 0023). Where a figure is missing it is filled from what
 * detection finds in the song's own file (the source preview), and failing that the grid is
 * a stand-in of 120 BPM with bar 1 at the start, until a tempo is typed or tapped.
 */

import type { Job, StemFile, StemSet } from '@/api/client'
import { type Grid, type Range, cleanRange } from '@/lib/grid'

export interface TrimStem {
  name: string
  path: string
  /** The larger stem it is a part of: kick in drums. */
  group: string | null
  /** Its coarse peaks file, drawn until the stem is decoded. */
  peaks: string | null
  /** Seconds into the song where its file begins: above 0 when leading silence was trimmed. */
  start: number
  /** How long its file lasts, when the engine said. */
  seconds: number | null
}

/** A tempo and where bar 1 is, either of them unknown. */
export interface Figures {
  bpm: number | null
  downbeat: number | null
}

export interface TrimSong {
  /** The job's id, or the stem folder of a song from the History: what the editor keeps it by. */
  id: string
  /** The job, when the song is in the queue. */
  jobId: string | null
  title: string
  /** The recipe it was, or will be, separated with. */
  recipe: string
  quality: string | null
  /**
   * In the queue and not started yet. A selection on a waiting song gives a clip of its own
   * file; whether it may also limit what gets separated is a setting of its own.
   */
  waiting: boolean
  /** The song's own file, when it is there: drawn, played and cut as "Original". */
  ownFile: string | null
  /** The stem folder, once it is separated. */
  directory: string | null
  stems: TrimStem[]
  /** The tempo and bar 1 the song carries: given by the user, or found by detection. */
  saved: Figures
  /** What detection found before the first edit, when the engine kept it (`analysis.detected`). */
  detected: Figures | null
  /**
   * The part of a waiting song chosen to be separated alone, as the engine named it. It is
   * separated alone only while the separate_selection setting is on when the song starts.
   */
  range: JobPart | null
  /**
   * Where this song's timeline starts in the whole song, in seconds: 0, or for the stems of
   * a part separated alone, the part's start (their 0 is there). A selection kept from before
   * the song was separated is moved by it.
   */
  origin: number
}

/** A part of a song as the engine keeps it: seconds of the song, and its name ("bars 9-16"). */
export interface JobPart {
  start: number
  end: number
  label: string
}

const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * The part of a waiting song chosen to be separated alone (`options.range`, set through
 * `POST /v1/jobs/{id}/range`), or null. Only a song that has not started has one that counts.
 */
export function jobRange(job: Pick<Job, 'state' | 'options'>): JobPart | null {
  if (job.state !== 'queued') return null
  const range = job.options?.range
  if (!range || typeof range !== 'object') return null
  const { start, end, label } = range as Record<string, unknown>
  const s = number(start)
  const e = number(end)
  return s !== null && e !== null && e > s && typeof label === 'string' && label ? { start: s, end: e, label } : null
}

/** The tempo and bar 1 in a job's `analysis` or `options`, or a stem set's `analysis`. */
function figuresOf(record: Record<string, unknown> | null | undefined): Figures {
  return { bpm: number(record?.bpm), downbeat: number(record?.downbeat) }
}

/** What detection found before the user's first change, if the engine kept it. */
function detectedOf(analysis: Record<string, unknown> | null | undefined): Figures | null {
  const detected = analysis?.detected
  return detected && typeof detected === 'object' ? figuresOf(detected as Record<string, unknown>) : null
}

function stemOf(stem: StemFile): TrimStem {
  const seconds = stem.samples && stem.sample_rate ? stem.samples / stem.sample_rate : null
  return {
    name: stem.name,
    path: stem.path,
    group: stem.group ?? null,
    peaks: stem.peaks ?? null,
    start: Math.max(0, stem.start ?? 0),
    seconds,
  }
}

/**
 * Stems of only a part of a song are a song of their own: their timeline starts at the part's
 * start, and the song's own file, on the whole song's timeline, does not line up with them.
 */
function isPart(record: Job | StemSet): boolean {
  return 'part' in record && record.part !== null && record.part !== undefined
}

/** Where a record's timeline starts in the whole song: the start of the part that ran, else 0. */
function originOf(record: Job | StemSet): number {
  const start = 'part' in record ? record.part?.start : undefined
  return typeof start === 'number' && Number.isFinite(start) ? start : 0
}

/** A song in the queue. Only a song that waits to start or is separated is trimmed. */
export function songOfJob(job: Job): TrimSong {
  const separated = job.state === 'done' && Boolean(job.output_dir)
  return {
    id: job.id,
    jobId: job.id,
    title: job.track_name,
    recipe: job.recipe_name,
    quality: job.quality,
    waiting: job.state === 'queued',
    ownFile: (separated && isPart(job)) || !job.track_path ? null : job.track_path,
    directory: separated ? (job.output_dir ?? null) : null,
    stems: separated ? job.stems.map(stemOf) : [],
    // Before it runs, the figures the user gave it are in its options.
    saved: figuresOf(separated ? job.analysis : job.options),
    detected: separated ? detectedOf(job.analysis) : null,
    range: jobRange(job),
    origin: separated ? originOf(job) : 0,
  }
}

/** A song from the History, by its stem folder. */
export function songOfStemSet(set: StemSet): TrimSong {
  return {
    id: set.directory,
    jobId: null,
    title: set.track_name,
    recipe: set.recipe_name,
    quality: null,
    waiting: false,
    ownFile: set.source_exists && !isPart(set) ? set.track_path : null,
    directory: set.directory,
    stems: set.stems.map(stemOf),
    saved: figuresOf(set.analysis),
    detected: detectedOf(set.analysis),
    range: null,
    origin: originOf(set),
  }
}

/**
 * A stretch kept on one timeline, put on another: `from` and `to` are where each starts in
 * the whole song. What falls outside `duration` (when it is known) is cut off, and a stretch
 * left too short to be a selection is null.
 */
export function moveRange(range: Range, from: number, to: number, duration: number): Range | null {
  const shift = from - to
  if (shift === 0 && (duration <= 0 || range.end <= duration)) return range
  return cleanRange(range.start + shift, range.end + shift, duration > 0 ? duration : Number.POSITIVE_INFINITY)
}

/** Whether a job can be opened in the editor: waiting to start, or separated. */
export function canTrim(job: Pick<Job, 'state' | 'stems' | 'track_path'>): boolean {
  return (job.state === 'queued' && Boolean(job.track_path)) || (job.state === 'done' && job.stems.length > 0)
}

/** How long the song is, as far as is known: its stems' reach, or its own file's length. */
export function songSeconds(song: TrimSong, previewSeconds: number | null): number {
  let longest = previewSeconds ?? 0
  for (const stem of song.stems) if (stem.seconds !== null) longest = Math.max(longest, stem.start + stem.seconds)
  return longest
}

/* ---- the grid ---------------------------------------------------------------------- */

/** The tempo of the stand-in grid when no tempo was found anywhere. */
const STAND_IN_BPM = 120

export interface SongGrid {
  /** The grid as the song has it now. */
  grid: Grid
  /** A tempo was found or given. When not, `grid` is a stand-in and clips are named by their times. */
  found: boolean
  /**
   * Bar 1 is the song's own (given, or kept with its analysis), not borrowed from the preview's
   * detection or the stand-in. A borrowed bar 1 fits only the tempo it came with, so it is saved
   * with any change: otherwise a new tempo would leave the song without one.
   */
  ownDownbeat: boolean
  /** What detection found, as a grid: what "was" and Reset refer to. */
  detected: Grid
  /** The same as figures, unknowns kept: what Reset saves. */
  detectedFigures: Figures
}

/** Whether two tempos are the same beat, near enough for one's bar 1 to fit the other. */
const sameTempo = (a: number, b: number) => Math.abs(a - b) <= 0.05

/**
 * Figures filled in from the preview's detection: a missing tempo takes the preview's, with
 * its bar 1; a missing bar 1 takes the preview's only when the preview found the same tempo.
 * What is still missing is the stand-in: 120 BPM, bar 1 at the start.
 */
export function fillFigures(base: Figures, preview: Figures | null): { grid: Grid; found: boolean } {
  let { bpm, downbeat } = base
  if (bpm === null && preview?.bpm != null) {
    bpm = preview.bpm
    downbeat ??= preview.downbeat
  } else if (bpm !== null && downbeat === null && preview?.bpm != null && preview.downbeat !== null && sameTempo(preview.bpm, bpm)) {
    downbeat = preview.downbeat
  }
  return { grid: { bpm: bpm ?? STAND_IN_BPM, downbeat: downbeat ?? 0, beatsPerBar: 4 }, found: bpm !== null }
}

/**
 * The song's grid, and what detection found. A separated song has its tempo and bar 1 in its
 * analysis; a waiting song has what its job was given, else what the preview detects. What
 * was detected comes from `analysis.detected` once something was changed, else it is the
 * figures as they are (for a waiting song: the preview's).
 */
export function songGrid(song: TrimSong, preview: Figures | null): SongGrid {
  const now = fillFigures(song.saved, preview)
  const detectedFigures: Figures = song.waiting ? (preview ?? { bpm: null, downbeat: null }) : (song.detected ?? song.saved)
  return {
    grid: now.grid,
    found: now.found,
    ownDownbeat: song.saved.downbeat !== null,
    detected: fillFigures(detectedFigures, preview).grid,
    detectedFigures,
  }
}

export interface GridChange {
  bpm?: number | null
  downbeat?: number | null
}

/**
 * What to save so that the song's grid becomes `next`, given the grid it has: the tempo only
 * when it changed (a new tempo renames the files that hold it), bar 1 when it moved or when
 * it is not the song's own yet (it renames nothing). `tempo` says the user meant a tempo
 * (typed, tapped, fitted): over a stand-in grid it is saved even when it is the stand-in's
 * own 120. Null when nothing changed.
 */
export function gridChange(saved: SongGrid, next: Grid, tempo: boolean): GridChange | null {
  const change: GridChange = {}
  if (Math.abs(next.bpm - saved.grid.bpm) > 1e-9 || (tempo && !saved.found)) change.bpm = next.bpm
  if (Math.abs(next.downbeat - saved.grid.downbeat) > 1e-9 || (!saved.ownDownbeat && 'bpm' in change)) change.downbeat = next.downbeat
  return 'bpm' in change || 'downbeat' in change ? change : null
}

/**
 * What Reset saves: for a waiting song, nothing of the user's (the run detects again); for a
 * separated one, the figures detection found, unknowns as none.
 */
export function resetChange(song: TrimSong, saved: SongGrid): GridChange | null {
  const target: Figures = song.waiting ? { bpm: null, downbeat: null } : saved.detectedFigures
  const change: GridChange = {}
  if (target.bpm !== song.saved.bpm) change.bpm = target.bpm
  if (target.downbeat !== song.saved.downbeat) change.downbeat = target.downbeat
  return 'bpm' in change || 'downbeat' in change ? change : null
}
