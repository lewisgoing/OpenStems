import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import cases from '../../../engine/tests/fixtures/clip_labels.json'
import { ApiError, type Job, type Peaks, type Schemas, type Settings, type StemFile, type StemSet } from '@/api/client'
import { PeaksWave } from '@/audio/pyramid'
import { jobMenuItems } from '@/components/RowMenu'
import { StemsPanel } from '@/components/StemsPanel'
import { ToastProvider } from '@/components/toast'
import { TooltipProvider } from '@/components/ui'
import { type Grid, TapTempo, cleanDownbeat, rangeLabel, timeAtBar } from '@/lib/grid'
import { type ClipRequest, forgetClips, useClipFiles } from '@/state/clip'
import { SelectionProvider } from '@/state/selection'
import { TrimEditor, type TrimEditorProps } from '@/trimmer/TrimEditor'
import { FRESH, type TrimMemory, forgetAll, recall, remember } from '@/trimmer/memory'
import {
  BARS_KEY,
  type Chip,
  OPEN_STEMS,
  type Pick,
  SOURCE,
  audibleOf,
  barRange,
  barsOf,
  barsRange,
  choose,
  clipNameParts,
  clipRequest,
  clipsFolder,
  clock,
  defaultPick,
  flagPlace,
  folderParts,
  isChosen,
  isZoomWheel,
  moved,
  nudgeDownbeat,
  nudgeEdge,
  parseBars,
  parseClock,
  peaksOf,
  pickOfAudible,
  readout,
  sameGrid,
  sectionsOf,
  seekPlace,
  spanned,
  targetOf,
  targetTitle,
  validPick,
  wholeNear,
  zoomFactor,
} from '@/trimmer/model'
import { colorChannels, mixColors } from '@/trimmer/canvas'
import { canTrim, fillFigures, gridChange, jobRange, moveRange, resetChange, songGrid, songOfJob, songOfStemSet, songSeconds } from '@/trimmer/song'
import { SORT_KEY } from '@/lib/queuesort'
import { QueueView, statusText } from '@/views/QueueView'
import { SettingsView } from '@/views/SettingsView'
import { bridge } from './setup'
import { TrimPlayer } from './trimstub'

/* The trimmer: the editor that cuts a part out of a song or its stems (docs/adr/0023-trimmer.md). */

const createClips = { mutateAsync: vi.fn() }
const createMix = { mutateAsync: vi.fn() }
const setAnalysis = { job: { mutateAsync: vi.fn() }, stemSet: { mutateAsync: vi.fn() } }
const actions = {
  startAll: { mutate: vi.fn() },
  start: { mutate: vi.fn() },
  cancel: { mutate: vi.fn() },
  retry: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  reorder: { mutate: vi.fn() },
  clearFinished: { mutate: vi.fn() },
}
type Preview = Schemas['SourcePreview']
let preview: { data?: Preview; isPending: boolean; isError: boolean; error: unknown } = { isPending: true, isError: false, error: null }
let jobs: Job[] = []
const SETTINGS: Settings = {
  auto_start: false,
  cache_dir: 'D:\\cache',
  default_quality: 'balanced',
  default_recipe: 'full-song',
  detect_tempo_key: true,
  match_source_rate: false,
  models_dir: 'D:\\models',
  naming_template: '{track} - {stem}',
  normalize: false,
  output_dir: 'D:\\out',
  output_format: 'wav32f',
  separate_selection: false,
  hide_empty_stems: true,
  sum_to_mix: false,
  tempo_sync: false,
  trim_silence: false,
  use_gpu: true,
  vram_budget_gb: 0,
  watch_enabled: false,
  watch_folder: '',
  write_midi: false,
}
let engineSettings: Settings = SETTINGS
const patchSettings = { mutate: vi.fn() }

vi.mock('@/audio/trimplayer', async () => await import('./trimstub'))
vi.mock('@/api/queries', () => ({
  keys: { jobs: ['jobs'] },
  useJobs: () => ({ data: jobs }),
  useJobActions: () => actions,
  useSetAnalysis: () => setAnalysis,
  useLinks: () => ({ data: [] }),
  useLinkActions: () => ({ add: { mutate: vi.fn() }, retry: { mutate: vi.fn() }, remove: { mutate: vi.fn() } }),
  useCreateMix: () => createMix,
  useCreateClips: () => createClips,
  // As the real query: nothing is asked for a song without its own file.
  useSourcePreview: (path: string | null) => (path ? preview : { data: undefined, isPending: true, isError: false, error: null }),
  useSystem: () => ({ data: undefined }),
  useSettings: () => ({ data: engineSettings }),
  usePatchSettings: () => patchSettings,
  useMaintenance: () => ({
    rebuildIndex: { mutate: vi.fn(), isPending: false },
    exportDiagnostics: { mutate: vi.fn(), isPending: false },
    selfTest: { mutate: vi.fn(), isPending: false, data: undefined },
  }),
  useModelActions: () => ({ pull: { mutate: vi.fn() } }),
}))
vi.mock('@/api/engine', () => ({
  useEngine: () => ({
    api: { GET: async () => ({ data: undefined, error: { detail: 'no peaks here' }, response: { status: 404 } }) },
    connection: { baseUrl: 'http://127.0.0.1:1', token: 't' },
  }),
}))
vi.mock('@/components/Waveform', () => ({
  Waveform: ({ label }: { label: string }) => <div data-testid="waveform">{label}</div>,
  useSharedGain: () => 1,
}))

/* ---- a song in the queue: drums in three parts, bass, and vocals that start late ---- */

const DIR = 'D:\\out\\Song\\every-stem'
const stem = (name: string, group: string | null = null, start = 0): StemFile => ({
  name,
  empty: false,
  file: `Song - ${name}.wav`,
  path: `${DIR}\\Song - ${name}.wav`,
  peaks: null,
  samples: 44100 * 60,
  sample_rate: 44100,
  group,
  start,
})
const STEMS = [stem('kick', 'drums'), stem('snare', 'drums'), stem('hh', 'drums'), stem('bass'), stem('vocals', null, 1.5)]
const pathOf = (name: string) => `${DIR}\\Song - ${name}.wav`

const job = (patch: Partial<Job> = {}): Job => ({
  id: 'j1',
  track_path: 'C:\\in\\Song.mp3',
  track_name: 'Song',
  recipe_id: 'every-stem',
  recipe_name: 'Every stem',
  quality: 'balanced',
  state: 'done',
  progress: 1,
  message: '',
  error: null,
  cached: false,
  output_dir: DIR,
  options: {},
  stems: STEMS,
  analysis: { bpm: 120, key: 'Am', downbeat: 0.5 },
  queue_position: null,
  held: false,
  created_at: 0,
  started_at: null,
  finished_at: null,
  notes: [],
  ...patch,
})

const waitingJob = (options: Record<string, unknown> = {}) =>
  job({ id: 'w1', state: 'queued', held: true, output_dir: null, stems: [], analysis: {}, options, queue_position: 0 })

const stemSet = (patch: Partial<StemSet> = {}): StemSet => ({
  directory: DIR,
  track_name: 'Song',
  track_path: 'C:\\in\\Song.mp3',
  track_hash: 'abc',
  recipe_id: 'every-stem',
  recipe_name: 'Every stem',
  created_at: '2026-11-23T10:00:00+0000',
  analysis: { bpm: 120, key: 'Am' },
  stems: STEMS,
  source_exists: true,
  ...patch,
})

const GRID: Grid = { bpm: 120, downbeat: 0.5, beatsPerBar: 4 }
const song = songOfJob(job())

const previewOf = (analysis: { bpm: number | null; downbeat: number | null }): Preview => ({
  audio: 'D:\\cache\\previews\\abc.flac',
  peaks: 'D:\\cache\\previews\\abc.peaks.json',
  duration: 60,
  sample_rate: 44100,
  analysis: { ...analysis, key: null },
})

beforeEach(() => {
  vi.clearAllMocks()
  forgetClips()
  forgetAll()
  jobs = []
  engineSettings = SETTINGS
  preview = { data: previewOf({ bpm: 120, downbeat: 0.5 }), isPending: false, isError: false, error: null }
  createClips.mutateAsync.mockImplementation(async (body: Schemas['CreateClips']) =>
    body.paths.map((_path, i) => ({ path: `${DIR}\\Clips\\clip ${i}.wav`, name: `clip ${i}.wav`, label: '', stems: [], start: body.start, end: body.end, samples: 1, sample_rate: 44100 })),
  )
  createMix.mutateAsync.mockImplementation(async () => ({ path: `${DIR}\\Mixes\\Song - mix.wav` }))
})

/* ---- the twins ------------------------------------------------------------------- */

describe('the twins of domain/grid.py', () => {
  interface LabelCase {
    bpm: number | null
    downbeat: number | null
    beats_per_bar?: number
    start: number
    end: number
    label: string
    note: string
  }

  it.each((cases as LabelCase[]).map((c) => [c.note, c] as const))('names a selection as clip_label does: %s', (_note, c) => {
    // No tempo is no grid; four beats to the bar unless the case says otherwise.
    const grid = c.bpm === null || c.downbeat === null ? null : { bpm: c.bpm, downbeat: c.downbeat, beatsPerBar: c.beats_per_bar ?? 4 }
    expect(rangeLabel(grid, { start: c.start, end: c.end })).toBe(c.label)
  })

  it('reads every case of the shared fixture', () => {
    expect((cases as LabelCase[]).length).toBeGreaterThanOrEqual(30)
  })

  it('keeps bar 1 as clean_downbeat does: four decimals, a half rounded up', () => {
    expect(cleanDownbeat(2.00005)).toEqual({ ok: true, value: 2.0001 })
    expect(cleanDownbeat(1.23456789)).toEqual({ ok: true, value: 1.2346 })
    expect(cleanDownbeat(1.00015)).toEqual({ ok: true, value: 1.0002 })
    expect(cleanDownbeat(0.00005)).toEqual({ ok: true, value: 0.0001 })
    expect(cleanDownbeat(-59.99999)).toEqual({ ok: true, value: -60 })
    expect(cleanDownbeat(-60)).toEqual({ ok: true, value: -60 })
    expect(cleanDownbeat(86400)).toEqual({ ok: true, value: 86400 })
    expect(cleanDownbeat('  2.5 ')).toEqual({ ok: true, value: 2.5 })
    expect(cleanDownbeat('1e1')).toEqual({ ok: true, value: 10 })
    // Python's 0.0, not JavaScript's -0.
    const zero = cleanDownbeat(-0.00005)
    expect(zero.ok && Object.is(zero.value, -0)).toBe(false)
    expect(zero).toEqual({ ok: true, value: 0 })
  })

  it('takes nothing for none, and refuses what is not a time in range', () => {
    for (const blank of [null, undefined, '', '   ']) expect(cleanDownbeat(blank)).toEqual({ ok: true, value: null })
    for (const wrong of ['abc', '0x10', Number.POSITIVE_INFINITY, Number.NaN, -60.0001, 86400.001]) {
      expect(cleanDownbeat(wrong)).toEqual({ ok: false, error: 'Bar 1 must be a time in seconds.' })
    }
  })
})

/* ---- the song ---------------------------------------------------------------------- */

describe('a song to trim', () => {
  it('is a separated job with its stems, or a waiting one with its own file only', () => {
    expect(song).toMatchObject({ id: 'j1', jobId: 'j1', title: 'Song', waiting: false, ownFile: 'C:\\in\\Song.mp3', directory: DIR })
    expect(song.stems.map((s) => [s.name, s.group, s.start, s.seconds])).toEqual([
      ['kick', 'drums', 0, 60],
      ['snare', 'drums', 0, 60],
      ['hh', 'drums', 0, 60],
      ['bass', null, 0, 60],
      ['vocals', null, 1.5, 60],
    ])
    // Its length: the stem that starts late reaches furthest.
    expect(songSeconds(song, null)).toBe(61.5)
    expect(songSeconds(song, 62)).toBe(62)
    const waiting = songOfJob(waitingJob({ bpm: 87 }))
    expect(waiting).toMatchObject({ waiting: true, directory: null, stems: [], saved: { bpm: 87, downbeat: null } })
    expect(songSeconds(waiting, null)).toBe(0)
  })

  it('is a stem set from the History, without its own file once that is gone', () => {
    expect(songOfStemSet(stemSet())).toMatchObject({ id: DIR, jobId: null, ownFile: 'C:\\in\\Song.mp3', waiting: false })
    expect(songOfStemSet(stemSet({ source_exists: false })).ownFile).toBeNull()
  })

  it("is trimmed on a part's own timeline, without the song's own file, when only a part was separated", () => {
    const part = { start: 16.5, end: 32.5, label: 'bars 9-16' }
    expect(songOfJob(job({ part })).ownFile).toBeNull()
    expect(songOfJob(job({ part })).stems).toHaveLength(5)
    expect(songOfStemSet(stemSet({ part })).ownFile).toBeNull()
    // Waiting, the part is only what will be separated: the song is still the whole file.
    expect(songOfJob({ ...waitingJob(), part }).ownFile).toBe('C:\\in\\Song.mp3')
  })

  it('can be trimmed while it waits to start and once it is separated, not while it runs', () => {
    expect(canTrim(job())).toBe(true)
    expect(canTrim(waitingJob())).toBe(true)
    expect(canTrim(job({ state: 'running', stems: [] }))).toBe(false)
    expect(canTrim(job({ state: 'failed', stems: [] }))).toBe(false)
  })
})

describe('the grid of a song', () => {
  const done = (analysis: Record<string, unknown>) => songOfJob(job({ analysis }))

  it('is what a separated song carries', () => {
    const saved = songGrid(done({ bpm: 87, downbeat: 1.686 }), null)
    expect(saved).toMatchObject({ grid: { bpm: 87, downbeat: 1.686, beatsPerBar: 4 }, found: true })
    // Nothing was changed yet: what was detected is what it carries.
    expect(saved.detected).toEqual(saved.grid)
  })

  it("takes a missing bar 1 from the song's own file only when it found the same tempo", () => {
    expect(songGrid(done({ bpm: 128 }), { bpm: 128.04, downbeat: 0.31 }).grid.downbeat).toBe(0.31)
    expect(songGrid(done({ bpm: 128 }), { bpm: 64, downbeat: 0.31 }).grid.downbeat).toBe(0)
    expect(songGrid(done({ bpm: 128 }), { bpm: 128, downbeat: null }).grid.downbeat).toBe(0)
    // Its own bar 1 wins over the preview's.
    expect(songGrid(done({ bpm: 128, downbeat: 2 }), { bpm: 128, downbeat: 0.31 }).grid.downbeat).toBe(2)
  })

  it("takes a missing tempo from the song's own file, with its bar 1", () => {
    expect(songGrid(done({}), { bpm: 140, downbeat: 0.2 })).toMatchObject({ grid: { bpm: 140, downbeat: 0.2 }, found: true })
  })

  it('is a stand-in of 120 BPM with bar 1 at the start when no tempo was found anywhere', () => {
    expect(songGrid(done({}), null)).toMatchObject({ grid: { bpm: 120, downbeat: 0, beatsPerBar: 4 }, found: false })
    expect(songGrid(done({}), { bpm: null, downbeat: null }).found).toBe(false)
    expect(fillFigures({ bpm: null, downbeat: 3 }, null)).toEqual({ grid: { bpm: 120, downbeat: 3, beatsPerBar: 4 }, found: false })
  })

  it('of a waiting song is what it was given, else what its own file shows', () => {
    const given = songGrid(songOfJob(waitingJob({ bpm: 87, downbeat: 1.2 })), { bpm: 173.4, downbeat: 0.31 })
    expect(given.grid).toMatchObject({ bpm: 87, downbeat: 1.2 })
    // What was detected is the preview's.
    expect(given.detected).toMatchObject({ bpm: 173.4, downbeat: 0.31 })
    const plain = songGrid(songOfJob(waitingJob()), { bpm: 173.4, downbeat: 0.31 })
    expect(plain.grid).toMatchObject({ bpm: 173.4, downbeat: 0.31 })
    expect(sameGrid(plain.grid, plain.detected)).toBe(true)
  })

  it('remembers what was detected field by field, unknowns filled as the grid is', () => {
    const edited = songGrid(done({ bpm: 87, downbeat: 1.686, detected: { bpm: 173.4, key: 'C', downbeat: null } }), { bpm: 173.4, downbeat: 0.31 })
    expect(edited.grid).toMatchObject({ bpm: 87, downbeat: 1.686 })
    expect(edited.detectedFigures).toEqual({ bpm: 173.4, downbeat: null })
    // The older stem set never had a bar 1: the preview's, since its tempo is the same.
    expect(edited.detected).toMatchObject({ bpm: 173.4, downbeat: 0.31 })
  })

  it('saves the tempo only when it changed, bar 1 only when it moved', () => {
    const saved = songGrid(done({ bpm: 120, downbeat: 0.5 }), null)
    expect(gridChange(saved, { ...GRID, downbeat: 0.75 }, false)).toEqual({ downbeat: 0.75 })
    expect(gridChange(saved, { ...GRID, bpm: 87 }, true)).toEqual({ bpm: 87 })
    expect(gridChange(saved, GRID, true)).toBeNull()
    // Over a stand-in, a tempo the user means is saved even when it is the stand-in's, with the
    // bar 1 it is drawn from.
    const none = songGrid(done({}), null)
    expect(gridChange(none, { bpm: 120, downbeat: 0, beatsPerBar: 4 }, true)).toEqual({ bpm: 120, downbeat: 0 })
    expect(gridChange(none, { bpm: 120, downbeat: 0.4, beatsPerBar: 4 }, false)).toEqual({ downbeat: 0.4 })
  })

  it("saves a borrowed bar 1 with a new tempo, so the bars stay where they were", () => {
    // A waiting song drawn from its preview: Half keeps bar 1 where detection put it.
    const waiting = songGrid(songOfJob(waitingJob()), { bpm: 173.4, downbeat: 0.31 })
    expect(waiting.ownDownbeat).toBe(false)
    expect(gridChange(waiting, { ...waiting.grid, bpm: 86.7 }, false)).toEqual({ bpm: 86.7, downbeat: 0.31 })
    // A stem set from before bar 1 was kept, with its tempo and the preview's bar 1.
    const older = songGrid(songOfStemSet(stemSet({ analysis: { bpm: 128 } })), { bpm: 128, downbeat: 0.31 })
    expect(gridChange(older, { ...older.grid, bpm: 64 }, false)).toEqual({ bpm: 64, downbeat: 0.31 })
    // Bar 1 alone is still bar 1 alone, and a song's own bar 1 is not sent again.
    expect(gridChange(older, { ...older.grid, downbeat: 0.5 }, false)).toEqual({ downbeat: 0.5 })
    const own = songGrid(songOfStemSet(stemSet({ analysis: { bpm: 128, downbeat: 0.31 } })), null)
    expect(gridChange(own, { ...own.grid, bpm: 64 }, false)).toEqual({ bpm: 64 })
  })

  it('resets a separated song to what was detected, and a waiting one to detecting again', () => {
    const edited = done({ bpm: 87, downbeat: 1.686, detected: { bpm: 173.4, downbeat: 0.31 } })
    expect(resetChange(edited, songGrid(edited, null))).toEqual({ bpm: 173.4, downbeat: 0.31 })
    const nothing = done({ bpm: 87, downbeat: 0.31, detected: { bpm: null, downbeat: 0.31 } })
    expect(resetChange(nothing, songGrid(nothing, null))).toEqual({ bpm: null })
    const waiting = songOfJob(waitingJob({ bpm: 87 }))
    expect(resetChange(waiting, songGrid(waiting, { bpm: 173.4, downbeat: 0.31 }))).toEqual({ bpm: null })
    const untouched = songOfJob(waitingJob())
    expect(resetChange(untouched, songGrid(untouched, null))).toBeNull()
  })
})

/* ---- the model ------------------------------------------------------------------- */

describe('what the chips choose', () => {
  const stems = (...names: string[]): Pick => ({ kind: 'stems', names })

  it('lays the stems out with the parts of a group together', () => {
    expect(sectionsOf(song)).toEqual([
      { group: 'drums', stems: ['kick', 'snare', 'hh'] },
      { group: null, stems: ['bass'] },
      { group: null, stems: ['vocals'] },
    ])
  })

  it('takes one chip alone, and adds or takes out another with the key held', () => {
    let pick = choose(song, SOURCE, { kind: 'stem', name: 'kick' }, false)
    expect(pick).toEqual(stems('kick'))
    pick = choose(song, pick, { kind: 'stem', name: 'bass' }, true)
    expect(pick).toEqual(stems('kick', 'bass'))
    expect(targetOf(song, pick)).toEqual({ kind: 'mix', names: ['kick', 'bass'] })
    expect(targetTitle(song, targetOf(song, pick))).toBe('Kick + bass')
    pick = choose(song, pick, { kind: 'stem', name: 'kick' }, true)
    expect(pick).toEqual(stems('bass'))
    // The last stem cannot be taken out.
    expect(choose(song, pick, { kind: 'stem', name: 'bass' }, true)).toEqual(stems('bass'))
  })

  it('takes a whole group as the group, and every stem as every stem, never the song itself', () => {
    const drums: Chip = { kind: 'group', group: 'drums', parts: ['kick', 'snare', 'hh'] }
    const pick = choose(song, SOURCE, drums, false)
    expect(targetOf(song, pick)).toEqual({ kind: 'group', group: 'drums' })
    expect(targetTitle(song, targetOf(song, pick))).toBe('Drums')
    expect(isChosen(pick, drums)).toBe(true)
    expect(isChosen(pick, { kind: 'stem', name: 'snare' })).toBe(true)
    expect(isChosen(pick, { kind: 'source' })).toBe(false)
    // Not every recipe's stems add up to the song: every stem is a mix of the stems.
    const everyStem = choose(song, choose(song, pick, { kind: 'stem', name: 'bass' }, true), { kind: 'stem', name: 'vocals' }, true)
    expect(everyStem).toEqual(stems('kick', 'snare', 'hh', 'bass', 'vocals'))
    expect(validPick(song, everyStem)).toEqual(everyStem)
    expect(targetTitle(song, targetOf(song, everyStem))).toBe('Every stem')
    expect(clipRequest(song, targetOf(song, everyStem), null, GRID)).toEqual({ kind: 'mix', paths: STEMS.map((s) => s.path) })
    const orphan = songOfStemSet(stemSet({ source_exists: false }))
    expect(choose(orphan, stems('kick', 'snare', 'hh', 'bass'), { kind: 'stem', name: 'vocals' }, true)).toEqual(stems('kick', 'snare', 'hh', 'bass', 'vocals'))
    expect(targetTitle(orphan, targetOf(orphan, defaultPick(orphan)))).toBe('Every stem')
  })

  it("trims a recipe's only stem, and every stem of one whose stems overlap, as stems", () => {
    // Drumless has one stem, the song without its drums: its chip takes that stem.
    const drumless = songOfJob(job({ recipe_id: 'drumless', stems: [stem('drumless')] }))
    const only = choose(drumless, defaultPick(drumless), { kind: 'stem', name: 'drumless' }, false)
    expect(only).toEqual(stems('drumless'))
    expect(targetOf(drumless, only)).toEqual({ kind: 'stem', name: 'drumless' })
    expect(clipRequest(drumless, targetOf(drumless, only), { start: 2.5, end: 4.5 }, GRID)).toMatchObject({
      kind: 'clips',
      clips: { paths: [pathOf('drumless')], together: true, source: false },
    })
    // Drum-kit's parts overlap its drums: every stem the panel plays is a mix of them, not the song.
    const kit = ['kick', 'snare', 'toms', 'hh', 'ride', 'crash', 'drums']
    const drumKit = songOfJob(job({ recipe_id: 'drum-kit', stems: kit.map((name) => stem(name)) }))
    expect(pickOfAudible(drumKit, null)).toEqual(stems(...kit))
    expect(pickOfAudible(drumKit, kit)).toEqual(stems(...kit))
    expect(clipRequest(drumKit, targetOf(drumKit, stems(...kit)), { start: 2.5, end: 4.5 }, GRID)).toMatchObject({
      kind: 'clips',
      clips: { paths: kit.map(pathOf), together: true, source: false },
    })
  })

  it("starts on the song's own file, or on every stem when it is gone, and mends a pick kept from before", () => {
    expect(defaultPick(song)).toEqual(SOURCE)
    const orphan = songOfStemSet(stemSet({ source_exists: false }))
    expect(defaultPick(orphan)).toEqual(stems('kick', 'snare', 'hh', 'bass', 'vocals'))
    expect(validPick(orphan, SOURCE)).toEqual(defaultPick(orphan))
    expect(validPick(song, stems('bass', 'gone'))).toEqual(stems('bass'))
    expect(validPick(song, stems('gone'))).toEqual(SOURCE)
  })

  it('hears what is chosen, and opens on what the stems panel leaves audible', () => {
    expect(audibleOf(SOURCE)).toEqual(['original'])
    expect(audibleOf(stems('kick', 'bass'))).toEqual(['stem:kick', 'stem:bass'])
    expect(pickOfAudible(song, ['bass', 'vocals'])).toEqual(stems('bass', 'vocals'))
    // The panel plays stems, not the song's own file: nothing soloed or muted is every stem.
    expect(pickOfAudible(song, null)).toEqual(stems('kick', 'snare', 'hh', 'bass', 'vocals'))
    expect(pickOfAudible(song, ['kick', 'snare', 'hh', 'bass', 'vocals'])).toEqual(stems('kick', 'snare', 'hh', 'bass', 'vocals'))
    expect(pickOfAudible(song, [])).toEqual(SOURCE)
  })

  it('opens a song of many stems on one file, not on every stem decoded at once', () => {
    // every-stem's 13: nothing soloed opens on the song's own file, or on the first stem
    // when that is gone; so does one muted. What is soloed is still what opens.
    const names = ['kick', 'snare', 'toms', 'hh', 'cymbals', 'other drums', 'lead', 'backing vocals', 'bass', 'guitar', 'piano', 'synth', 'other']
    expect(names.length).toBeGreaterThan(OPEN_STEMS)
    const big = songOfJob(job({ stems: names.map((name) => stem(name)) }))
    expect(pickOfAudible(big, null)).toEqual(SOURCE)
    expect(pickOfAudible(big, names.filter((name) => name !== 'kick'))).toEqual(SOURCE)
    expect(pickOfAudible(big, ['bass', 'lead'])).toEqual(stems('lead', 'bass'))
    const orphan = songOfStemSet(stemSet({ source_exists: false, stems: names.map((name) => stem(name)) }))
    expect(defaultPick(orphan)).toEqual(stems('kick'))
    expect(pickOfAudible(orphan, null)).toEqual(stems('kick'))
    // At the cap, every stem still opens together.
    const eight = songOfJob(job({ stems: names.slice(0, OPEN_STEMS).map((name) => stem(name)) }))
    expect(pickOfAudible(eight, null)).toEqual(stems(...names.slice(0, OPEN_STEMS)))
  })

  it("draws each stem's peaks from where its file begins in the song", () => {
    // The vocals' leading silence was trimmed: their file begins 1.5 s into the song.
    expect(peaksOf(song, stems('bass', 'vocals'), null)).toEqual([
      { path: null, start: 0 },
      { path: null, start: 1.5 },
    ])
    expect(peaksOf(song, SOURCE, 'D:\\cache\\abc.peaks.json')).toEqual([{ path: 'D:\\cache\\abc.peaks.json', start: 0 }])
    // One block a second, loud all through: silent before 1.5 s, loud after it.
    const loud = { sample_rate: 44100, samples_per_peak: 44100, length: 4, samples: 4 * 44100, data: [-1, 1, -1, 1, -1, 1, -1, 1] } as unknown as Peaks
    const wave = new PeaksWave(peaksOf(song, stems('vocals'), null).map((part) => ({ peaks: loud, start: part.start })))
    expect(wave.length).toBe(Math.ceil(5.5 * 44100))
    expect(wave.span(0, 44100)).toEqual([0, 0])
    expect(wave.span(2 * 44100, 3 * 44100)).toEqual([-1, 1])
  })

  it('puts a stem back at its place in the song before it is played: its silence, then its sound', async () => {
    const { padToSong } = await vi.importActual<typeof import('@/audio/trimplayer')>('@/audio/trimplayer')
    const copies: { channel: number; offset: number; length: number }[] = []
    const context = {
      createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => ({
        numberOfChannels,
        length,
        sampleRate,
        copyToChannel: (data: Float32Array, channel: number, offset = 0) => copies.push({ channel, offset, length: data.length }),
      }),
    }
    const decoded = { numberOfChannels: 2, length: 44100, sampleRate: 44100, getChannelData: () => new Float32Array(44100) }
    const padded = padToSong(context as never, decoded as never, 1.5)
    expect(padded.length).toBe(44100 + 66150)
    expect(copies).toEqual([
      { channel: 0, offset: 66150, length: 44100 },
      { channel: 1, offset: 66150, length: 44100 },
    ])
    // A file that starts with the song is played as it is.
    expect(padToSong(context as never, decoded as never, 0)).toBe(decoded)
  })
})

describe('selecting on the grid', () => {
  const D = 600
  it('snaps both ends, and a short drag inside a bar takes the bar', () => {
    expect(spanned(GRID, 16.4, 32.7, 'bar', false, D)).toEqual({ start: 16.5, end: 32.5 })
    expect(spanned(GRID, 17, 17.6, 'bar', false, D)).toEqual({ start: 16.5, end: 18.5 })
    // Free: exactly where the pointer went.
    expect(spanned(GRID, 16.4, 32.7, 'bar', true, D)).toEqual({ start: 16.4, end: 32.7 })
    expect(spanned(GRID, 16.4, 32.7, 'off', false, D)).toEqual({ start: 16.4, end: 32.7 })
  })

  it('moves a selection by whole steps, keeping its length and the song', () => {
    expect(moved(GRID, { start: 16.5, end: 32.5 }, 4.3, 'bar', false, D)).toEqual({ start: 20.5, end: 36.5 })
    expect(moved(GRID, { start: 16.5, end: 32.5 }, -100, 'bar', false, D)).toEqual({ start: 0, end: 16 })
    expect(barRange(GRID, 17, D)).toEqual({ start: 16.5, end: 18.5 })
  })

  it('moves an edge by the snap step from the keyboard, or by 10 ms, never across the other', () => {
    const sel = { start: 16.5, end: 32.5 }
    expect(nudgeEdge(GRID, sel, 'end', 1, 'bar', false, D)).toEqual({ start: 16.5, end: 34.5 })
    expect(nudgeEdge(GRID, sel, 'start', -1, 'beat', false, D)).toEqual({ start: 16, end: 32.5 })
    expect(nudgeEdge(GRID, sel, 'start', 1, 'off', false, D).start).toBeCloseTo(16.51, 9)
    expect(nudgeEdge(GRID, sel, 'end', -1, 'bar', true, D).end).toBeCloseTo(32.49, 9)
    // Off the grid, the first step lands on the next line.
    expect(nudgeEdge(GRID, { start: 17, end: 32.5 }, 'start', 1, 'bar', false, D).start).toBe(18.5)
    const short = { start: 16.5, end: 18.5 }
    expect(nudgeEdge(GRID, short, 'end', -1, 'bar', false, D)).toBe(short)
  })

  it('moves bar 1 by 10 ms, or a beat with Shift, inside what the engine takes', () => {
    expect(nudgeDownbeat(GRID, 1, false)).toBeCloseTo(0.51, 9)
    expect(nudgeDownbeat(GRID, -1, true)).toBe(0)
    expect(nudgeDownbeat({ ...GRID, downbeat: -59.995 }, -1, false)).toBe(-60)
  })

  it("puts the playhead on the nearest line, or at the song's start or end when that is nearer", () => {
    expect(seekPlace(GRID, 17, 'bar', false, D)).toBe(16.5)
    expect(seekPlace(GRID, 0.4, 'bar', false, D)).toBe(0.5)
    // No line is at 0:00 on this grid: a click nearer to it than to bar 1 goes there.
    expect(seekPlace(GRID, 0.2, 'bar', false, D)).toBe(0)
    expect(seekPlace({ ...GRID, downbeat: -1.5 }, 0.1, 'bar', false, D)).toBe(0)
    expect(seekPlace(GRID, 59.8, 'bar', false, 60)).toBe(60)
    expect(seekPlace(GRID, 0.2, 'bar', true, D)).toBe(0.2)
    expect(seekPlace(GRID, 0.2, 'off', false, D)).toBe(0.2)
    expect(seekPlace(GRID, -3, 'off', false, D)).toBe(0)
  })

  it("lets the song's start take hold of bar 1's flag close by, unless it is held free", () => {
    expect(flagPlace(0.3, 0.6, false)).toBe(0)
    expect(flagPlace(-0.3, 0.6, false)).toBe(0)
    expect(flagPlace(1, 0.6, false)).toBe(1)
    expect(flagPlace(-1, 0.6, false)).toBe(-1)
    expect(flagPlace(0.3, 0.6, true)).toBe(0.3)
  })

  it("gives a part so many bars: from the playhead's bar, or the part chosen made that long", () => {
    expect(barsRange(GRID, null, 17, 8, D)).toEqual({ start: 16.5, end: 32.5 })
    expect(barsRange(GRID, { start: 16.5, end: 18.5 }, 40, 4, D)).toEqual({ start: 16.5, end: 24.5 })
    // A part that starts off the grid keeps its start.
    expect(barsRange(GRID, { start: 17, end: 18 }, 0, 4, D)).toEqual({ start: 17, end: 25 })
    // The playhead before bar 1: the first bar line in the song.
    expect(barsRange(GRID, null, 0.2, 8, D)).toEqual({ start: 0.5, end: 16.5 })
    // Past the end it moves back by whole bars; in a song shorter than that it runs to the end.
    expect(barsRange(GRID, null, 58, 8, 60)).toEqual({ start: 42.5, end: 58.5 })
    expect(barsRange(GRID, null, 0, 8, 10)).toEqual({ start: 0.5, end: 10 })
    expect(barsOf(GRID, { start: 16.5, end: 32.5 })).toBe(8)
    expect(barsOf(GRID, { start: 17, end: 25 })).toBe(4)
    expect(barsOf(GRID, { start: 17, end: 24.3 })).toBeNull()
    expect(barsOf(null, { start: 16.5, end: 32.5 })).toBeNull()
    expect(barsOf(GRID, null)).toBeNull()
  })

  it('reads a typed number of bars, whole and from 1 to 999', () => {
    expect(parseBars('12')).toBe(12)
    expect(parseBars(' 8 ')).toBe(8)
    for (const text of ['', '0', '1.5', '-4', 'x', '1000']) expect(parseBars(text)).toBeNull()
  })

  it('says where and how long a selection is, by its times without a grid', () => {
    expect(readout(GRID, { start: 16.5, end: 32.5 })).toEqual({ where: 'Bars 9-16', length: '8 bars · 16.00 s' })
    expect(readout(GRID, { start: 17.5, end: 21 })).toEqual({ where: '9.3 to 11.2', length: '7 beats · 3.50 s' })
    expect(readout({ ...GRID, downbeat: 4.5 }, { start: 1.5, end: 3 }).where).toBe('-1.3 to 0.2')
    expect(readout(GRID, { start: 21.4, end: 33.1 })).toEqual({ where: '0:21.400 to 0:33.100', length: '11.70 s' })
    expect(readout(null, { start: 16.5, end: 32.5 })).toEqual({ where: '0:16.500 to 0:32.500', length: '16.00 s' })
    expect(timeAtBar(GRID, 9)).toBe(16.5)
  })

  it('reads a typed time, a minus included, and writes a running clock', () => {
    expect(parseClock('1.689')).toBe(1.689)
    expect(parseClock('0:01.689')).toBeCloseTo(1.689, 9)
    expect(parseClock('1:02,5')).toBe(62.5)
    expect(parseClock('-0:00.250')).toBe(-0.25)
    expect(parseClock('soon')).toBeNull()
    expect(clock(62.345)).toBe('1:02.35')
  })

  it('offers a whole tempo just beside a fitted one, and tells grids apart', () => {
    expect(wholeNear(86.97)).toBe(87)
    expect(wholeNear(87)).toBeNull()
    expect(wholeNear(86.5)).toBeNull()
    expect(sameGrid(GRID, { ...GRID })).toBe(true)
    expect(sameGrid(GRID, { ...GRID, downbeat: 0.51 })).toBe(false)
  })

  it('taps a tempo from three taps on', () => {
    const tapper = new TapTempo()
    expect(tapper.tap(0)).toBeNull()
    expect(tapper.tap(500)).toBeNull()
    expect(tapper.tap(1000)).toBe(120)
    // A pause starts over.
    expect(tapper.tap(4000)).toBeNull()
    expect(tapper.count).toBe(1)
  })

  it('zooms with Ctrl and the wheel on Windows, and scrolls with the wheel alone', () => {
    expect(isZoomWheel({ ctrlKey: true, metaKey: false }, false)).toBe(true)
    expect(isZoomWheel({ ctrlKey: false, metaKey: true }, false)).toBe(false)
    expect(isZoomWheel({ ctrlKey: false, metaKey: false }, false)).toBe(false)
    expect(zoomFactor({ deltaY: -100, ctrlKey: true, metaKey: false }, false)).toBeCloseTo(Math.exp(0.25), 9)
  })
})

describe('what a handle gives', () => {
  const sel = { start: 16.5, end: 32.5 }
  const grid = { bpm: 120, downbeat: 0.5, beats_per_bar: 4 }

  it("gives whole files without a selection: the song's own, a stem's, every stem's, a mix", () => {
    expect(clipRequest(song, { kind: 'source' }, null, GRID)).toEqual({ kind: 'files', paths: ['C:\\in\\Song.mp3'] })
    expect(clipRequest(song, { kind: 'stem', name: 'bass' }, null, GRID)).toEqual({ kind: 'files', paths: [pathOf('bass')] })
    expect(clipRequest(song, { kind: 'all' }, null, GRID)).toEqual({ kind: 'files', paths: STEMS.map((s) => s.path) })
    expect(clipRequest(song, { kind: 'group', group: 'drums' }, null, GRID)).toEqual({ kind: 'mix', paths: ['kick', 'snare', 'hh'].map(pathOf) })
  })

  it("asks for clips with a selection: of the song's own file, of stems together, or one each", () => {
    expect(clipRequest(song, { kind: 'source' }, sel, GRID)).toEqual({
      kind: 'clips',
      clips: { start: 16.5, end: 32.5, grid, paths: ['C:\\in\\Song.mp3'], together: true, source: true },
    })
    expect(clipRequest(song, { kind: 'mix', names: ['kick', 'bass'] }, sel, GRID)).toEqual({
      kind: 'clips',
      clips: { start: 16.5, end: 32.5, grid, paths: [pathOf('kick'), pathOf('bass')], together: true, source: false },
    })
    expect(clipRequest(song, { kind: 'all' }, sel, null)).toEqual({
      kind: 'clips',
      clips: { start: 16.5, end: 32.5, grid: null, paths: STEMS.map((s) => s.path), together: false, source: false },
    })
  })

  it('says where clips go, with the separator the folders already use', () => {
    expect(clipsFolder(song, { kind: 'stem', name: 'bass' }, 'D:\\out')).toBe(`${DIR}\\Clips`)
    expect(clipsFolder(song, { kind: 'source' }, 'D:\\out\\')).toBe('D:\\out\\Song\\Clips')
    const mac = songOfJob(job({ track_path: '/Users/me/Music/Song?.mp3', output_dir: '/Users/me/Music/OpenStems/Song/full-song' }))
    expect(clipsFolder(mac, { kind: 'source' }, '/Users/me/Music/OpenStems')).toBe('/Users/me/Music/OpenStems/Song_/Clips')
    expect(clipsFolder(mac, { kind: 'stem', name: 'bass' }, null)).toBe('/Users/me/Music/OpenStems/Song/full-song/Clips')
  })

  it('cuts a long name in the song, never in what the file holds or its part', () => {
    expect(clipNameParts('Night Loop - drums - bars 2-3.wav', 'drums', 'bars 2-3')).toEqual({ head: 'Night Loop - ', tail: 'drums - bars 2-3.wav' })
    expect(clipNameParts('Song - drums + bass - 1.2-1.4 (2).wav', 'drums + bass', '1.2-1.4')).toEqual({ head: 'Song - ', tail: 'drums + bass - 1.2-1.4 (2).wav' })
    // The song's own file holds the song: its part alone never gives way.
    expect(clipNameParts('Night Loop - bars 2-3.wav', '', 'bars 2-3')).toEqual({ head: 'Night Loop - ', tail: 'bars 2-3.wav' })
    // A template that puts the stem first: the part is found alone.
    expect(clipNameParts('drums - bars 2-3 - Night Loop.wav', 'drums', 'bars 2-3')).toEqual({ head: 'drums - ', tail: 'bars 2-3 - Night Loop.wav' })
    expect(clipNameParts('Song.mp3', '', '')).toEqual({ head: 'Song.mp3', tail: '' })
    // Where clips go keeps its last two folders whole.
    expect(folderParts('D:\\out\\Song\\full-song\\Clips')).toEqual({ head: 'D:\\out\\Song', tail: '\\full-song\\Clips' })
    expect(folderParts('/Users/me/Music/OpenStems/Song/Clips')).toEqual({ head: '/Users/me/Music/OpenStems', tail: '/Song/Clips' })
    expect(folderParts('Clips')).toEqual({ head: 'Clips', tail: '' })
  })

  it('mixes two token colors for the canvas, in any form the stylesheet writes them', () => {
    expect(colorChannels('#e9eaed')).toEqual([233, 234, 237])
    expect(colorChannels('#fff')).toEqual([255, 255, 255])
    expect(colorChannels('rgb(22, 24, 28)')).toEqual([22, 24, 28])
    expect(colorChannels('rgb(22 24 28 / 50%)')).toEqual([22, 24, 28])
    expect(colorChannels('oklch(0.7 0.1 120)')).toBeNull()
    expect(mixColors('#ffffff', 'rgb(0 0 0)', 0.5)).toBe('rgb(128 128 128)')
    // One it cannot read gives the first as it is, never a wrong mix.
    expect(mixColors('oklch(0.7 0.1 120)', '#000', 0.5)).toBe('oklch(0.7 0.1 120)')
  })
})

describe("the editor's memory", () => {
  it('keeps each song as it was left, for the session', () => {
    expect(recall('j1')).toEqual(FRESH)
    const left: TrimMemory = { pick: SOURCE, sel: { start: 1, end: 2 }, snap: 'beat', view: { t0: 0, t1: 10 }, fitted: true, origin: 0 }
    remember('j1', left)
    expect(recall('j1')).toEqual(left)
    forgetAll()
    expect(recall('j1')).toEqual(FRESH)
  })

  it("moves a part kept on the whole song's timeline onto a part's own, and drops what falls outside it", () => {
    // A waiting song's bars 11-15, 20.5 to 30.5 s, separated alone: its stems' 0 is 20.5 s.
    expect(moveRange({ start: 20.5, end: 30.5 }, 0, 20.5, 10)).toEqual({ start: 0, end: 10 })
    expect(moveRange({ start: 22.5, end: 24.5 }, 0, 20.5, 10)).toEqual({ start: 2, end: 4 })
    // Partly outside: cut to the part; wholly outside: none.
    expect(moveRange({ start: 18.5, end: 22.5 }, 0, 20.5, 10)).toEqual({ start: 0, end: 2 })
    expect(moveRange({ start: 2.5, end: 4.5 }, 0, 20.5, 10)).toBeNull()
    // The same timeline: as it was, kept inside a length learnt since; a length not known yet cuts nothing.
    expect(moveRange({ start: 2.5, end: 4.5 }, 0, 0, 60)).toEqual({ start: 2.5, end: 4.5 })
    expect(moveRange({ start: 2.5, end: 64.5 }, 0, 0, 60)).toEqual({ start: 2.5, end: 60 })
    expect(moveRange({ start: 22.5, end: 24.5 }, 0, 20.5, 0)).toEqual({ start: 2, end: 4 })
  })
})

/* ---- the files a drag hands over ------------------------------------------------- */

function Files({ request, wanted, settled, scope = 'j1', onError }: { request: ClipRequest | null; wanted?: boolean; settled?: boolean; scope?: string; onError?: (error: unknown) => void }) {
  const files = useClipFiles(scope, request, { wanted, settled, onError })
  return <button type="button" data-testid="files" data-state={files.status} data-paths={JSON.stringify(files.paths)} data-names={files.names.join('|')} onClick={files.retry} />
}

describe('useClipFiles', () => {
  const body = (start = 16.5) => ({ start, end: 32.5, grid: { bpm: 120, downbeat: 0.5, beats_per_bar: 4 }, paths: [pathOf('kick')], together: true, source: false })
  const clips = (start = 16.5): ClipRequest => ({ kind: 'clips', clips: body(start) })
  const files = () => screen.getByTestId('files')

  it('gives files that are there at once, asking the engine nothing', () => {
    render(<Files request={{ kind: 'files', paths: [pathOf('bass')] }} />)
    expect(files()).toHaveAttribute('data-state', 'ready')
    expect(files()).toHaveAttribute('data-names', 'Song - bass.wav')
    expect(createClips.mutateAsync).not.toHaveBeenCalled()
    expect(createMix.mutateAsync).not.toHaveBeenCalled()
  })

  it('writes a group or a mix of whole stems through the mixes route', async () => {
    render(<Files request={{ kind: 'mix', paths: ['kick', 'snare', 'hh'].map(pathOf) }} />)
    expect(files()).toHaveAttribute('data-state', 'preparing')
    await waitFor(() => expect(files()).toHaveAttribute('data-state', 'ready'))
    expect(createMix.mutateAsync).toHaveBeenCalledTimes(1)
    expect(createMix.mutateAsync).toHaveBeenCalledWith(['kick', 'snare', 'hh'].map(pathOf))
    expect(files()).toHaveAttribute('data-names', 'Song - mix.wav')
  })

  it('asks for clips only while wanted, and only once no gesture is under way', async () => {
    const { rerender } = render(<Files request={clips()} wanted={false} />)
    expect(files()).toHaveAttribute('data-state', 'idle')
    rerender(<Files request={clips()} wanted settled={false} />)
    expect(files()).toHaveAttribute('data-state', 'preparing')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)))
    expect(createClips.mutateAsync).not.toHaveBeenCalled()
    rerender(<Files request={clips()} wanted settled />)
    await waitFor(() => expect(files()).toHaveAttribute('data-state', 'ready'))
    expect(createClips.mutateAsync).toHaveBeenCalledTimes(1)
    expect(createClips.mutateAsync).toHaveBeenCalledWith(body())
    expect(files()).toHaveAttribute('data-names', 'clip 0.wav')
  })

  it('asks once for the last of quick changes, and keeps what it wrote for coming back', async () => {
    const { rerender, unmount } = render(<Files request={clips(16.5)} />)
    rerender(<Files request={clips(18.5)} />)
    rerender(<Files request={clips(20.5)} />)
    await waitFor(() => expect(files()).toHaveAttribute('data-state', 'ready'))
    expect(createClips.mutateAsync).toHaveBeenCalledTimes(1)
    expect(createClips.mutateAsync.mock.calls[0]?.[0]).toMatchObject({ start: 20.5 })
    unmount()
    // The same request again, in an editor opened again: ready at once.
    render(<Files request={clips(20.5)} />)
    expect(files()).toHaveAttribute('data-state', 'ready')
    expect(createClips.mutateAsync).toHaveBeenCalledTimes(1)
    // Another song's clip of the same stretch is its own.
    render(<Files request={clips(20.5)} scope="j2" />)
    expect(screen.getAllByTestId('files')[1]).toHaveAttribute('data-state', 'preparing')
  })

  it('says why a clip was not written, and asks again when told to', async () => {
    const onError = vi.fn()
    createClips.mutateAsync.mockRejectedValueOnce(new ApiError('the selection is too short'))
    render(<Files request={clips()} onError={onError} />)
    await waitFor(() => expect(files()).toHaveAttribute('data-state', 'failed'))
    expect(onError).toHaveBeenCalledWith(new ApiError('the selection is too short'))
    fireEvent.click(files())
    await waitFor(() => expect(files()).toHaveAttribute('data-state', 'ready'))
    expect(createClips.mutateAsync).toHaveBeenCalledTimes(2)
  })
})

/* ---- the editor ------------------------------------------------------------------- */

function tree(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function openEditor(props: Partial<TrimEditorProps> = {}) {
  const onBack = vi.fn()
  const onCommit = vi.fn(async () => undefined)
  const view = render(tree(<TrimEditor song={song} initial={FRESH} instant={false} leaving={false} onBack={onBack} onCommit={onCommit} {...props} />))
  const player = TrimPlayer.last
  if (!player) throw new Error('no player')
  return { ...view, onBack, onCommit: (props.onCommit as typeof onCommit | undefined) ?? onCommit, player }
}

const chip = (name: string) => screen.getByRole('button', { name })
const editorEl = () => screen.getByTestId('trim-editor')

describe('the trimmer', () => {
  it('chooses what to trim with chips, and mixes stems with Ctrl+click', async () => {
    const { player } = openEditor()
    expect(chip('Original')).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByRole('group', { name: 'drums' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Drums', 'kick', 'snare', 'hh'])
    expect(player.state.audible).toEqual(['original'])

    fireEvent.click(chip('kick'))
    expect(chip('kick')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('Original')).toHaveAttribute('aria-pressed', 'false')
    expect(player.state.audible).toEqual(['stem:kick'])

    fireEvent.click(chip('bass'), { ctrlKey: true })
    expect(chip('kick')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('bass')).toHaveAttribute('aria-pressed', 'true')
    expect(editorEl()).toHaveAttribute('data-target', 'Kick + bass')
    expect(player.state.audible).toEqual(['stem:kick', 'stem:bass'])
    // A plain click takes that chip alone again.
    fireEvent.click(chip('Drums'))
    expect(editorEl()).toHaveAttribute('data-target', 'Drums')
    expect(chip('bass')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Ctrl+click to mix several stems')).toBeInTheDocument()

    // Without a part, a mix of whole stems is written as the stems panel writes its mix.
    await waitFor(() => expect(createMix.mutateAsync).toHaveBeenCalledWith(['kick', 'snare', 'hh'].map(pathOf)))
    await waitFor(() => expect(screen.getByTestId('clip-handle')).toHaveAttribute('data-state', 'ready'))
  })

  it('saves a typed tempo, the tempo alone', async () => {
    const { onCommit } = openEditor()
    expect(screen.getByTestId('tempo-field')).toHaveValue('120')
    expect(screen.getByTestId('tempo-was')).toHaveTextContent('detected')
    const field = screen.getByTestId('tempo-field')
    await userEvent.clear(field)
    await userEvent.type(field, '87{Enter}')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith({ bpm: 87 })
  })

  it('saves bar 1 alone a moment after the last nudge', async () => {
    const { onCommit } = openEditor()
    fireEvent.click(screen.getByTestId('downbeat-later'))
    fireEvent.click(screen.getByTestId('downbeat-later'))
    // Shown at once, saved once.
    expect(editorEl()).toHaveAttribute('data-downbeat', String(0.5 + 0.01 + 0.01))
    expect(onCommit).not.toHaveBeenCalled()
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    expect(onCommit).toHaveBeenCalledWith({ downbeat: 0.52 })
  })

  it('puts the saved grid back and says why when saving fails', async () => {
    const onCommit = vi.fn(async () => {
      throw new ApiError('Song - kick 120.wav is open in another program')
    })
    openEditor({ onCommit })
    fireEvent.click(screen.getByRole('button', { name: 'Half the tempo' }))
    expect(onCommit).toHaveBeenCalledWith({ bpm: 60 })
    expect(await screen.findByText('Song - kick 120.wav is open in another program')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('tempo-field')).toHaveValue('120'))
  })

  it('keeps a saved grid shown until the song has it, so a quick second change builds on it', async () => {
    // The song's new figures reach the editor a tick after the save resolves (the jobs list's
    // cache). Until then the old grid must not show, nor be built on.
    const onCommit = vi.fn(async () => undefined)
    const props = { initial: FRESH, instant: false, leaving: false, onBack: vi.fn(), onCommit }
    const view = render(tree(<TrimEditor song={song} {...props} />))
    const double = () => fireEvent.click(screen.getByRole('button', { name: 'Double the tempo' }))
    double()
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ bpm: 240 }))
    await act(async () => undefined)
    expect(editorEl()).toHaveAttribute('data-bpm', '240')
    double()
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ bpm: 480 }))
    await act(async () => undefined)
    // The song catches up: the draft goes, and from then on the song's grid is what shows.
    const at = (bpm: number) => songOfJob(job({ analysis: { bpm, key: 'Am', downbeat: 0.5 } }))
    view.rerender(tree(<TrimEditor song={at(480)} {...props} />))
    expect(editorEl()).toHaveAttribute('data-bpm', '480')
    view.rerender(tree(<TrimEditor song={at(100)} {...props} />))
    expect(editorEl()).toHaveAttribute('data-bpm', '100')
  })

  it('sends grid saves one after another, so an older one never lands last', async () => {
    // Two at once could reach the engine in either order: a tempo saved with bar 1 pinned
    // where it showed would then undo bar 1 typed right after it.
    const pending: (() => void)[] = []
    const onCommit = vi.fn(() => new Promise<undefined>((resolve) => pending.push(() => resolve(undefined))))
    openEditor({ onCommit })
    const double = () => fireEvent.click(screen.getByRole('button', { name: 'Double the tempo' }))
    double()
    double()
    await act(async () => undefined)
    // Only the first is on its way; the second waits for it.
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ bpm: 240 }))
    await act(async () => pending[0]?.())
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2))
    expect(onCommit).toHaveBeenLastCalledWith(expect.objectContaining({ bpm: 480 }))
    await act(async () => pending[1]?.())
  })

  it('shows what was saved after a moment when the song never quite shows the draft', async () => {
    const onCommit = vi.fn(async () => undefined)
    openEditor({ onCommit })
    fireEvent.click(screen.getByRole('button', { name: 'Double the tempo' }))
    await act(async () => undefined)
    expect(editorEl()).toHaveAttribute('data-bpm', '240')
    // The song here is never updated: its own 120 comes back once the draft has waited enough.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)))
    expect(editorEl()).toHaveAttribute('data-bpm', '120')
  })

  it("shows Preparing, then the engine's file name, and drags those files", async () => {
    const written = `${DIR}\\Clips\\Song - kick - bar 2.wav`
    createClips.mutateAsync.mockImplementationOnce(async () => [{ path: written, name: 'Song - kick - bar 2.wav', label: 'kick', stems: ['kick'], start: 2.5, end: 4.5, samples: 88200, sample_rate: 44100 }])
    openEditor({ initial: { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, sel: { start: 2.5, end: 4.5 } } })
    const handle = screen.getByTestId('clip-handle')
    expect(handle).toHaveAttribute('data-state', 'preparing')
    expect(handle).toHaveTextContent('Preparing')
    expect(screen.getByTestId('readout')).toHaveTextContent('Bar 2 · 1 bar · 2.00 s')
    // A drag before the file is there hands nothing over.
    fireEvent.dragStart(handle)
    expect(bridge.startDrag).not.toHaveBeenCalled()
    await waitFor(() => expect(handle).toHaveAttribute('data-state', 'ready'))
    expect(createClips.mutateAsync).toHaveBeenCalledWith({
      start: 2.5,
      end: 4.5,
      grid: { bpm: 120, downbeat: 0.5, beats_per_bar: 4 },
      paths: [pathOf('kick')],
      together: true,
      source: false,
    })
    expect(screen.getByTestId('clip-name')).toHaveTextContent('Song - kick - bar 2.wav')
    fireEvent.dragStart(handle)
    expect(bridge.startDrag).toHaveBeenCalledWith([written])
    expect(screen.getByTestId('trim-foot')).toHaveTextContent(`Clips go to ${DIR}\\Clips`)
  })

  it('writes every stem of the part, one file each, only once the pointer reaches it', async () => {
    openEditor({ initial: { ...FRESH, sel: { start: 2.5, end: 4.5 } } })
    const all = screen.getByTestId('all-handle')
    await waitFor(() => expect(screen.getByTestId('clip-handle')).toHaveAttribute('data-state', 'ready'))
    expect(all).toHaveAttribute('data-state', 'idle')
    expect(createClips.mutateAsync).toHaveBeenCalledTimes(1)
    fireEvent.pointerEnter(all)
    await waitFor(() => expect(all).toHaveAttribute('data-state', 'ready'))
    expect(createClips.mutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ paths: STEMS.map((s) => s.path), together: false, source: false }))
    fireEvent.dragStart(all)
    expect(bridge.startDrag).toHaveBeenLastCalledWith(STEMS.map((_, i) => `${DIR}\\Clips\\clip ${i}.wav`))
  })

  it("drags the song's own file whole without a part", () => {
    openEditor()
    const handle = screen.getByTestId('clip-handle')
    expect(handle).toHaveAttribute('data-state', 'ready')
    expect(screen.getByTestId('clip-name')).toHaveTextContent('Song.mp3')
    fireEvent.dragStart(handle)
    expect(bridge.startDrag).toHaveBeenCalledWith(['C:\\in\\Song.mp3'])
  })

  it('goes back with Back, and Escape clears the part before it leaves', async () => {
    const { onBack } = openEditor({ initial: { ...FRESH, sel: { start: 2.5, end: 4.5 } } })
    await userEvent.click(screen.getByTestId('trim-back'))
    expect(onBack).toHaveBeenLastCalledWith(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('readout')).toHaveTextContent('No part chosen')
    expect(onBack).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onBack).toHaveBeenLastCalledWith(true)
  })

  it('plays with Space, but not while a field is typed in', () => {
    const { player } = openEditor()
    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    expect(player.state.playing).toBe(true)
    fireEvent.keyDown(screen.getByTestId('tempo-field'), { key: ' ', code: 'Space' })
    expect(player.state.playing).toBe(true)
    fireEvent.keyDown(window, { key: ' ', code: 'Space' })
    expect(player.state.playing).toBe(false)
  })

  it('moves the edges of the part and bar 1 from the keyboard', async () => {
    const { onCommit } = openEditor({ initial: { ...FRESH, sel: { start: 2.5, end: 4.5 } } })
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of the selection' }), { key: 'ArrowRight' })
    expect(editorEl()).toHaveAttribute('data-sel', '2.5,6.5')
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Bar 1' }), { key: 'ArrowLeft', shiftKey: true })
    expect(editorEl()).toHaveAttribute('data-downbeat', '0')
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith({ downbeat: 0 }))
  })

  it('says how far what is chosen is decoded, under the clock', async () => {
    const { player } = openEditor()
    fireEvent.click(chip('Drums'))
    act(() => player.markTracks({ 'stem:kick': { state: 'ready' }, 'stem:snare': { state: 'loading' }, 'stem:hh': { state: 'loading' } }))
    await waitFor(() => expect(screen.getByText('loading 1/3')).toBeInTheDocument())
    act(() => player.markTracks({ 'stem:kick': { state: 'ready' }, 'stem:snare': { state: 'ready' }, 'stem:hh': { state: 'ready' } }))
    await waitFor(() => expect(screen.getByText('bar 0.4')).toBeInTheDocument())
  })

  it('appears at once when opened from the keyboard', async () => {
    openEditor({ instant: true })
    expect(editorEl()).toHaveClass('trim-instant')
    await waitFor(() => expect(editorEl()).not.toHaveClass('trim-instant'))
  })

  it('has only the song itself while it waits to be separated, read first', () => {
    preview = { isPending: true, isError: false, error: null }
    const waiting = songOfJob(waitingJob({ bpm: 87 }))
    const { rerender, onBack, onCommit } = openEditor({ song: waiting })
    expect(screen.getByRole('status')).toHaveTextContent('Reading the song')
    expect(screen.getByText('Single stems can be trimmed once it is separated.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Original/ })).toHaveLength(1)
    expect(screen.queryByTestId('all-handle')).not.toBeInTheDocument()
    preview = { data: previewOf({ bpm: 173.4, downbeat: 0.31 }), isPending: false, isError: false, error: null }
    rerender(tree(<TrimEditor song={waiting} initial={FRESH} instant={false} leaving={false} onBack={onBack} onCommit={onCommit} />))
    expect(screen.getByTestId('tempo-field')).toHaveValue('87')
    expect(screen.getByTestId('tempo-was')).toHaveTextContent('was 173.4')
    expect(editorEl()).toHaveAttribute('data-waiting', 'true')
    // Reset takes away what it was given: the run detects again.
    fireEvent.click(screen.getByTestId('grid-reset'))
    expect(onCommit).toHaveBeenCalledWith({ bpm: null })
  })

  it('halves a waiting song drawn from its preview with bar 1 kept where detection put it', () => {
    preview = { data: previewOf({ bpm: 173.4, downbeat: 0.31 }), isPending: false, isError: false, error: null }
    const { onCommit } = openEditor({ song: songOfJob(waitingJob()) })
    expect(screen.getByTestId('tempo-was')).toHaveTextContent('detected')
    fireEvent.click(screen.getByRole('button', { name: 'Half the tempo' }))
    expect(onCommit).toHaveBeenCalledWith({ bpm: 86.7, downbeat: 0.31 })
  })

  it('says on the Original chip when the song cannot be read, and the stems still work', () => {
    preview = { isPending: false, isError: true, error: new ApiError("that song's file is not there any more"), data: undefined }
    openEditor()
    expect(chip('Original')).toHaveAttribute('title', "that song's file is not there any more")
    expect(screen.getByTestId('trim-status')).toHaveTextContent("The song could not be read: that song's file is not there any more")
    fireEvent.click(chip('bass'))
    expect(screen.queryByTestId('trim-status')).not.toBeInTheDocument()
  })

  it('names a part by its times while no tempo was found, until one is typed', async () => {
    preview = { data: previewOf({ bpm: null, downbeat: null }), isPending: false, isError: false, error: null }
    const none = songOfJob(job({ analysis: {} }))
    const { onCommit } = openEditor({ song: none, initial: { ...FRESH, pick: { kind: 'stems', names: ['bass'] }, sel: { start: 2.5, end: 4.5 } } })
    expect(screen.getByTestId('tempo-was')).toHaveTextContent('none found')
    // The field is empty: the song has no tempo; the grid's stand-in is its hint.
    expect(screen.getByTestId('tempo-field')).toHaveValue('')
    expect(screen.getByTestId('tempo-field')).toHaveAttribute('placeholder', '120')
    expect(screen.getByTestId('ruler-hint')).toHaveTextContent('No tempo was found in this song. Type it, or tap along with T.')
    expect(screen.getByTestId('readout')).toHaveTextContent('0:02.500 to 0:04.500')
    await waitFor(() => expect(createClips.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ grid: null })))
    await userEvent.type(screen.getByTestId('tempo-field'), '120{Enter}')
    expect(onCommit).toHaveBeenCalledWith({ bpm: 120, downbeat: 0 })
  })

  it('saves bar 1 nudged just before the editor is left, from the keyboard or with the pointer', async () => {
    const first = openEditor()
    fireEvent.click(screen.getByTestId('downbeat-later'))
    expect(first.onCommit).not.toHaveBeenCalled()
    // Esc: the editor goes at once. The nudge is saved as it goes.
    first.unmount()
    expect(first.onCommit).toHaveBeenCalledWith({ downbeat: 0.51 })

    // With the pointer: saved as the way out starts, so the view under the fade shows it.
    const onCommit = vi.fn(async () => undefined)
    const props = { song, initial: FRESH, instant: false, onBack: vi.fn(), onCommit }
    const view = render(tree(<TrimEditor {...props} leaving={false} />))
    fireEvent.click(screen.getByTestId('downbeat-beat-later'))
    view.rerender(tree(<TrimEditor {...props} leaving />))
    expect(onCommit).toHaveBeenCalledWith({ downbeat: 1 })
    view.unmount()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 500)))
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('saves a tapped tempo when the editor is left before the taps time out', async () => {
    const now = vi.spyOn(performance, 'now')
    try {
      const { onCommit, unmount } = openEditor()
      for (const t of [1000, 1400, 1800, 2200]) {
        now.mockReturnValue(t)
        fireEvent.keyDown(window, { key: 't', code: 'KeyT' })
      }
      expect(editorEl()).toHaveAttribute('data-bpm', '150')
      expect(onCommit).not.toHaveBeenCalled()
      unmount()
      expect(onCommit).toHaveBeenCalledWith({ bpm: 150 })
    } finally {
      now.mockRestore()
    }
  })

  it('writes every stem again only for a part the pointer reaches it on', async () => {
    openEditor({ initial: { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, sel: { start: 2.5, end: 4.5 } } })
    const all = screen.getByTestId('all-handle')
    const eachStem = () => createClips.mutateAsync.mock.calls.filter(([body]) => (body as Schemas['CreateClips']).together === false)
    fireEvent.pointerEnter(all)
    await waitFor(() => expect(all).toHaveAttribute('data-state', 'ready'))
    fireEvent.pointerLeave(all)
    expect(eachStem()).toHaveLength(1)
    // Other parts, chosen from the keyboard: the clip of the kick follows, every stem does not.
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of the selection' }), { key: 'ArrowRight' })
    await waitFor(() => expect(createClips.mutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ end: 6.5, together: true })))
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of the selection' }), { key: 'ArrowRight' })
    await waitFor(() => expect(createClips.mutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ end: 8.5, together: true })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 450)))
    expect(eachStem()).toHaveLength(1)
    expect(all).toHaveAttribute('data-state', 'idle')
    // Reached again: this part.
    fireEvent.pointerEnter(all)
    await waitFor(() => expect(all).toHaveAttribute('data-state', 'ready'))
    expect(eachStem()).toHaveLength(2)
    expect(eachStem()[1]?.[0]).toMatchObject({ start: 2.5, end: 8.5 })
  })

  it('asks the engine again when opened again: a clip deleted since, or cut from older stems, is written anew', async () => {
    const initial: TrimMemory = { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, sel: { start: 2.5, end: 4.5 } }
    const first = openEditor({ initial })
    await waitFor(() => expect(screen.getByTestId('clip-handle')).toHaveAttribute('data-state', 'ready'))
    first.unmount()
    openEditor({ initial })
    // Not handed out from before, unasked: the engine finds the clip if it is still right.
    expect(screen.getByTestId('clip-handle')).toHaveAttribute('data-state', 'preparing')
    await waitFor(() => expect(screen.getByTestId('clip-handle')).toHaveAttribute('data-state', 'ready'))
    expect(createClips.mutateAsync).toHaveBeenCalledTimes(2)
  })

  it('puts bar 1 where it reads when Enter is pressed on it, and shows a time typed in seconds as a time', async () => {
    // Bar 1 is kept to a tenth of a millisecond; the field shows milliseconds. The song is
    // never updated here, so each save keeps showing what it saved.
    const onCommit = vi.fn(async () => undefined)
    openEditor({ song: songOfJob(job({ analysis: { bpm: 120, key: 'Am', downbeat: 0.2503 } })), onCommit })
    const field = () => screen.getByTestId('downbeat-field')
    expect(field()).toHaveValue('0:00.250')
    // Passing through it without typing changes nothing.
    fireEvent.focus(field())
    fireEvent.blur(field())
    expect(onCommit).not.toHaveBeenCalled()
    // Typed as it reads, or Enter on it as it reads: bar 1 goes there.
    await userEvent.clear(field())
    await userEvent.type(field(), '0:00.250{Enter}')
    expect(onCommit).toHaveBeenCalledWith({ downbeat: 0.25 })
    expect(editorEl()).toHaveAttribute('data-downbeat', '0.25')
    // In seconds: once in, it reads as the time it is.
    await userEvent.clear(field())
    await userEvent.type(field(), '0.3{Enter}')
    expect(onCommit).toHaveBeenLastCalledWith({ downbeat: 0.3 })
    expect(field()).toHaveValue('0:00.300')
    // The same time again is no change.
    await userEvent.clear(field())
    await userEvent.type(field(), '0.30{Enter}')
    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  describe('with the waveform laid out, 10 px a second', () => {
    let width: { mockRestore: () => void } | null = null
    beforeEach(() => {
      width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    })
    afterEach(() => width?.mockRestore())
    const view = { t0: 0, t1: 60 }
    const drag = (from: number, to: number, keys: { altKey?: boolean } = {}) => {
      const wave = screen.getByTestId('trim-wave')
      fireEvent.pointerDown(wave, { button: 0, clientX: from, pointerId: 1, ...keys })
      fireEvent.pointerMove(wave, { clientX: (from + to) / 2, pointerId: 1, ...keys })
      fireEvent.pointerMove(wave, { clientX: to, pointerId: 1, ...keys })
      return () => fireEvent.pointerUp(wave, { clientX: to, pointerId: 1, ...keys })
    }

    it('writes no clip while a part is dragged, nor with a grid that is not saved yet', async () => {
      openEditor({ initial: { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, view } })
      const letGo = drag(27, 43)
      // On bar lines while it is dragged: bar 2, 2.5 to 4.5 s.
      expect(editorEl()).toHaveAttribute('data-sel', '2.5,4.5')
      await act(async () => new Promise((resolve) => setTimeout(resolve, 600)))
      expect(createClips.mutateAsync).not.toHaveBeenCalled()
      // Screen readers are told the part once the drag ends, not at every step.
      expect(within(screen.getByTestId('readout')).getByRole('status')).toHaveTextContent('No part chosen')
      letGo()
      expect(within(screen.getByTestId('readout')).getByRole('status')).toHaveTextContent('Bar 2 · 1 bar · 2.00 s')
      await waitFor(() => expect(createClips.mutateAsync).toHaveBeenCalledTimes(1))
      expect(createClips.mutateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ start: 2.5, end: 4.5, grid: { bpm: 120, downbeat: 0.5, beats_per_bar: 4 } }))
      // Bar 1 nudged: shown at once, saved a moment later. Nothing is cut on the unsaved grid.
      fireEvent.click(screen.getByTestId('downbeat-later'))
      await act(async () => new Promise((resolve) => setTimeout(resolve, 380)))
      expect(createClips.mutateAsync).toHaveBeenCalledTimes(1)
    })

    it('places a part freely with Alt held, and on the grid without it', () => {
      openEditor({ initial: { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, view } })
      drag(27, 43, { altKey: true })()
      expect(editorEl()).toHaveAttribute('data-sel', '2.7,4.3')
      expect(screen.getByTestId('readout')).toHaveTextContent('0:02.700 to 0:04.300')
      fireEvent.keyDown(window, { key: 'Escape' })
      drag(27, 43)()
      expect(editorEl()).toHaveAttribute('data-sel', '2.5,4.5')
    })

    it('loops a part dragged where there was none, and leaves the loop as it was set after that', () => {
      const { player } = openEditor({ initial: { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, view } })
      expect(player.state.loop).toBeNull()
      const letGo = drag(27, 43)
      // Not while it is dragged: once the pointer lets go.
      expect(player.state.loop).toBeNull()
      letGo()
      expect(player.state.loop).toEqual({ start: 2.5, end: 4.5 })
      expect(screen.getByTestId('loop')).toHaveAttribute('aria-pressed', 'true')
      // On, it follows a part dragged anew.
      drag(107, 123)()
      expect(player.state.loop).toEqual({ start: 10.5, end: 12.5 })
      // Turned off, it stays off for the next part: there was one already.
      fireEvent.click(screen.getByTestId('loop'))
      drag(27, 43)()
      expect(editorEl()).toHaveAttribute('data-sel', '2.5,4.5')
      expect(player.state.loop).toBeNull()
      // Cleared, the next part is a new one.
      fireEvent.keyDown(window, { key: 'Escape' })
      drag(107, 123)()
      expect(player.state.loop).toEqual({ start: 10.5, end: 12.5 })
    })

    it('loops a bar taken with a double click where there was no part', () => {
      const { player } = openEditor({ initial: { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, view } })
      fireEvent.doubleClick(screen.getByTestId('trim-wave'), { clientX: 30 })
      expect(editorEl()).toHaveAttribute('data-sel', '2.5,4.5')
      expect(player.state.loop).toEqual({ start: 2.5, end: 4.5 })
    })

    it('chooses a part of so many bars with one press, and keeps a length typed for next time', async () => {
      const { player, unmount } = openEditor({ initial: { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, view } })
      // No part yet: 8 bars from the playhead's bar, here the first bar line of the song.
      fireEvent.click(screen.getByTestId('bars-8'))
      expect(editorEl()).toHaveAttribute('data-sel', '0.5,16.5')
      expect(screen.getByTestId('bars-8')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByTestId('readout')).toHaveTextContent('Bars 1-8 · 8 bars')
      expect(player.state.loop).toEqual({ start: 0.5, end: 16.5 })
      // With a part: the same start, the new length.
      fireEvent.click(screen.getByTestId('bars-4'))
      expect(editorEl()).toHaveAttribute('data-sel', '0.5,8.5')
      expect(screen.getByTestId('bars-8')).toHaveAttribute('aria-pressed', 'false')
      expect(screen.getByTestId('bars-4')).toHaveAttribute('aria-pressed', 'true')
      expect(player.state.loop).toEqual({ start: 0.5, end: 8.5 })
      await userEvent.type(screen.getByTestId('bars-field'), '3{Enter}')
      expect(editorEl()).toHaveAttribute('data-sel', '0.5,6.5')
      expect(localStorage.getItem(BARS_KEY)).toBe('3')
      await userEvent.type(screen.getByTestId('bars-field'), 'x{Enter}')
      expect(await screen.findByText('Type a number of bars, from 1 to 999.')).toBeInTheDocument()
      expect(editorEl()).toHaveAttribute('data-sel', '0.5,6.5')
      // The next editor offers the length typed last.
      unmount()
      openEditor()
      expect(screen.getByTestId('bars-field')).toHaveValue('3')
    })

    it('shows a part of many bars whole when it reaches out of sight', () => {
      openEditor({ initial: { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, view: { t0: 0, t1: 6 } } })
      fireEvent.click(screen.getByTestId('bars-16'))
      expect(editorEl()).toHaveAttribute('data-sel', '0.5,32.5')
      expect(Number(editorEl().getAttribute('data-t0'))).toBe(0)
      expect(Number(editorEl().getAttribute('data-t1'))).toBeGreaterThan(32.5)
    })

    it('goes back to 0:00 with Home or its button: the playhead and the view', () => {
      const { player } = openEditor({ initial: { ...FRESH, view: { t0: 10, t1: 20 } } })
      player.seek(15)
      fireEvent.keyDown(window, { key: 'Home', code: 'Home' })
      expect(player.position).toBe(0)
      expect(editorEl()).toHaveAttribute('data-t0', '0')
      expect(editorEl()).toHaveAttribute('data-t1', '10')
      player.seek(7)
      fireEvent.click(screen.getByTestId('trim-start'))
      expect(player.position).toBe(0)
      // Not while a field is typed in: Home is the field's there.
      player.seek(7)
      fireEvent.keyDown(screen.getByTestId('tempo-field'), { key: 'Home', code: 'Home' })
      expect(player.position).toBe(7)
    })

    it('puts the playhead at 0:00 for a click nearer to it than to a line', () => {
      const { player } = openEditor({ initial: { ...FRESH, view } })
      player.seek(9)
      const wave = screen.getByTestId('trim-wave')
      fireEvent.pointerDown(wave, { button: 0, clientX: 2, pointerId: 1 })
      fireEvent.pointerUp(wave, { clientX: 2, pointerId: 1 })
      expect(player.position).toBe(0)
    })

    it('puts bar 1 at 0:00 with one press', async () => {
      const { onCommit } = openEditor({ initial: { ...FRESH, view } })
      const start = screen.getByTestId('downbeat-start')
      expect(start).toHaveAttribute('aria-disabled', 'false')
      fireEvent.click(start)
      expect(editorEl()).toHaveAttribute('data-downbeat', '0')
      expect(onCommit).toHaveBeenCalledWith({ downbeat: 0 })
      expect(start).toHaveAttribute('aria-disabled', 'true')
      // At 0:00 already: pressed again, nothing is saved.
      fireEvent.click(start)
      expect(onCommit).toHaveBeenCalledTimes(1)
    })

    describe('with bar 1 before the start of the song', () => {
      const flag = () => screen.getByTestId('bar-one-flag')
      const before = () => {
        const opened = openEditor({ initial: { ...FRESH, view } })
        // Two beats earlier with the keys: 0.5 s, 0 s, then half a second before the song.
        fireEvent.keyDown(flag(), { key: 'ArrowLeft', shiftKey: true })
        fireEvent.keyDown(flag(), { key: 'ArrowLeft', shiftKey: true })
        expect(editorEl()).toHaveAttribute('data-downbeat', '-0.5')
        return opened
      }

      it('keeps the flag at the left edge, and a drag from there brings bar 1 back in', async () => {
        const { onCommit } = before()
        expect(flag()).toHaveAttribute('data-pinned', 'true')
        expect(flag().style.transform).toBe('translateX(0px)')
        // A press without a drag leaves it where it is.
        fireEvent.pointerDown(flag(), { button: 0, clientX: 3, pointerId: 1 })
        fireEvent.pointerUp(flag(), { clientX: 3, pointerId: 1 })
        expect(editorEl()).toHaveAttribute('data-downbeat', '-0.5')
        // Dragged, it comes in under the pointer: 28 px to the right is 2.8 s later than the edge.
        fireEvent.pointerDown(flag(), { button: 0, clientX: 3, pointerId: 1 })
        fireEvent.pointerMove(flag(), { clientX: 20, pointerId: 1 })
        fireEvent.pointerMove(flag(), { clientX: 31, pointerId: 1 })
        fireEvent.pointerUp(flag(), { clientX: 31, pointerId: 1 })
        // Saves go one after another: this one follows the press's.
        await waitFor(() => expect(onCommit).toHaveBeenLastCalledWith({ downbeat: 2.8 }))
        expect(flag()).not.toHaveAttribute('data-pinned')
      })

      it('puts bar 1 at 0:00 for a double click on the flag', async () => {
        const { onCommit } = before()
        // The second press of a double click, then the double click itself, which a browser
        // sends from the ruler: it has the pointer.
        fireEvent.pointerDown(flag(), { button: 0, clientX: 3, pointerId: 1 })
        fireEvent.pointerUp(flag(), { clientX: 3, pointerId: 1 })
        fireEvent.doubleClick(screen.getByTestId('trim-ruler'), { clientX: 3 })
        expect(editorEl()).toHaveAttribute('data-downbeat', '0')
        await waitFor(() => expect(onCommit).toHaveBeenLastCalledWith({ downbeat: 0 }))
        // A double click elsewhere on the ruler leaves bar 1 alone.
        fireEvent.click(screen.getByTestId('downbeat-later'))
        fireEvent.pointerDown(screen.getByTestId('trim-ruler'), { button: 0, clientX: 300, pointerId: 1 })
        fireEvent.pointerUp(screen.getByTestId('trim-ruler'), { clientX: 300, pointerId: 1 })
        fireEvent.doubleClick(screen.getByTestId('trim-ruler'), { clientX: 300 })
        expect(editorEl()).toHaveAttribute('data-downbeat', '0.01')
      })

      it("lets the song's start take hold of a flag dragged close to it, unless Alt is held", () => {
        const { onCommit } = openEditor({ initial: { ...FRESH, view } })
        // Bar 1 is at 0.5 s, 5 px in. Dragged 3 px left it is 2 px from the start: it goes to 0:00.
        fireEvent.pointerDown(flag(), { button: 0, clientX: 5, pointerId: 1 })
        fireEvent.pointerMove(flag(), { clientX: 2, pointerId: 1 })
        expect(editorEl()).toHaveAttribute('data-downbeat', '0')
        // With Alt it goes exactly where it is put, before the start as well.
        fireEvent.pointerMove(flag(), { clientX: -5, pointerId: 1, altKey: true })
        fireEvent.pointerUp(flag(), { clientX: -5, pointerId: 1, altKey: true })
        expect(onCommit).toHaveBeenLastCalledWith({ downbeat: -0.5 })
        expect(flag()).toHaveAttribute('data-pinned', 'true')
      })
    })
  })
})

describe("a waiting song's part, separated alone", () => {
  // Bars 11-15 of the waiting song, 20.5 to 30.5 s: its stems are 10 s long, and their 0 is 20.5 s.
  const part = { start: 20.5, end: 30.5, label: 'bars 11-15' }
  const tenSeconds = STEMS.map((s) => ({ ...s, start: 0, samples: 441000 }))
  const separated = () => songOfJob(job({ id: 'w1', part, stems: tenSeconds, analysis: { bpm: 120, key: 'Am', downbeat: 0 }, options: { range: part } }))

  it("is trimmed on the part's own timeline, with the part chosen on the waiting song", async () => {
    const left: TrimMemory = { ...FRESH, pick: { kind: 'stems', names: ['kick'] }, sel: { start: 20.5, end: 30.5 }, view: { t0: 10, t1: 40 }, origin: 0 }
    const { unmount } = openEditor({ song: separated(), initial: left })
    expect(editorEl()).toHaveAttribute('data-duration', '10')
    expect(editorEl()).toHaveAttribute('data-sel', '0,10')
    expect(editorEl()).toHaveAttribute('data-t0', '0')
    expect(editorEl()).toHaveAttribute('data-t1', '10')
    await waitFor(() => expect(createClips.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ start: 0, end: 10 })))
    unmount()
    // Remembered on the part's timeline from now on.
    expect(recall('w1')).toMatchObject({ sel: { start: 0, end: 10 }, origin: 20.5 })
  })

  it('moves with the song when it comes back as its part while the editor is open', () => {
    const props = { initial: { ...FRESH, sel: { start: 22.5, end: 26.5 } }, instant: false, leaving: false, onBack: vi.fn(), onCommit: vi.fn(async () => undefined) }
    const view = render(tree(<TrimEditor song={songOfJob(waitingJob())} {...props} />))
    expect(editorEl()).toHaveAttribute('data-sel', '22.5,26.5')
    view.rerender(tree(<TrimEditor song={separated()} {...props} />))
    expect(editorEl()).toHaveAttribute('data-sel', '2,6')
    expect(editorEl()).toHaveAttribute('data-t1', '10')
  })
})

/* ---- the ways in ------------------------------------------------------------------- */

describe('the ways into the trimmer', () => {
  // These are about the rows, not their order: the list is pinned to the order songs run in.
  beforeEach(() => localStorage.setItem(SORT_KEY, 'run'))
  const settings = { default_recipe: 'full-song', default_quality: 'balanced', sum_to_mix: false } as Parameters<typeof SelectionProvider>[0]['settings']
  const queue = (onTrim = vi.fn()) =>
    render(
      tree(
        <SelectionProvider settings={settings}>
          <QueueView recipes={[]} models={[]} selectedJob={null} onSelect={vi.fn()} onAddFiles={vi.fn()} onPasteLink={vi.fn()} onTrim={onTrim} />
        </SelectionProvider>,
      ),
    )

  it('has Trim on a song waiting to start and on a separated one, not on one that runs or failed', async () => {
    jobs = [waitingJob(), job(), job({ id: 'r', state: 'running', stems: [], output_dir: null }), job({ id: 'f', state: 'failed', stems: [], output_dir: null })]
    const onTrim = vi.fn()
    queue(onTrim)
    const rows = screen.getAllByTestId('job-row')
    expect(within(rows[0]!).getByTestId('row-trim')).toHaveAttribute('data-trim-song', 'w1')
    expect(within(rows[1]!).getByRole('button', { name: 'Trim Song' })).toBeInTheDocument()
    expect(within(rows[2]!).queryByTestId('row-trim')).not.toBeInTheDocument()
    expect(within(rows[3]!).queryByTestId('row-trim')).not.toBeInTheDocument()
    await userEvent.click(within(rows[1]!).getByTestId('row-trim'))
    expect(onTrim).toHaveBeenCalledWith(jobs[1], false)
    fireEvent.click(within(rows[0]!).getByTestId('row-trim'), { detail: 0 })
    expect(onTrim).toHaveBeenLastCalledWith(jobs[0], true)
  })

  it("has Trim in a row's menu in the full window, after Show stems", async () => {
    jobs = [job()]
    const onTrim = vi.fn()
    queue(onTrim)
    fireEvent.contextMenu(screen.getByTestId('job-row'))
    const item = await screen.findByRole('menuitem', { name: 'Trim' })
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Show stems', 'Trim', 'Show in Explorer', 'Show the original in Explorer', 'Remove from the list'])
    await userEvent.click(item)
    expect(onTrim).toHaveBeenCalledWith(jobs[0], false)
    // Chosen from the keyboard (a click with no pointer behind it), the trimmer opens at once.
    fireEvent.contextMenu(screen.getByTestId('job-row'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Trim' }), { detail: 0 })
    expect(onTrim).toHaveBeenLastCalledWith(jobs[0], true)
  })

  it('offers Trim only where the window can open the trimmer', () => {
    const labels = (j: Job, trim?: () => void) => jobMenuItems(j, { trim, start: vi.fn() }).map((i) => i.label)
    expect(labels(waitingJob(), vi.fn())).toEqual(['Start now', 'Trim'])
    expect(labels(job({ state: 'running', stems: [] }), vi.fn())).not.toContain('Trim')
    // The quick-drop window passes no trim: it has no editor.
    expect(labels(job())).not.toContain('Trim')
  })

  it("opens the stems panel's Trim on what solo and mute leave audible, and keeps them", async () => {
    const onTrim = vi.fn()
    const panelStems = ['vocals', 'drums', 'bass'].map((name) => stem(name))
    render(tree(<StemsPanel title="Song" subtitle="Full song" directory={DIR} stems={panelStems} onTrim={onTrim} onClose={vi.fn()} />))
    await userEvent.click(screen.getByTestId('panel-trim'))
    expect(onTrim).toHaveBeenLastCalledWith(null, { instant: false, mix: { soloed: [], muted: [] } })
    await userEvent.click(screen.getByRole('button', { name: 'Mute vocals' }))
    await userEvent.click(screen.getByTestId('panel-trim'))
    expect(onTrim).toHaveBeenLastCalledWith(['drums', 'bass'], { instant: false, mix: { soloed: [], muted: ['vocals'] } })
  })

  it('brings solo and mute back with the panel', () => {
    const panelStems = ['vocals', 'drums', 'bass'].map((name) => stem(name))
    render(tree(<StemsPanel title="Song" subtitle="Full song" directory={DIR} stems={panelStems} initialMix={{ soloed: ['drums', 'bass'], muted: ['vocals'] }} onTrim={vi.fn()} onClose={vi.fn()} />))
    expect(screen.getByRole('button', { name: 'Solo drums' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Solo bass' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Mute vocals' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('leaves the stems panel without Trim where no trimmer is given', () => {
    render(tree(<StemsPanel title="Song" subtitle="Full song" directory={DIR} stems={[stem('bass')]} onClose={vi.fn()} />))
    expect(screen.queryByTestId('panel-trim')).not.toBeInTheDocument()
  })
})

/* ---- separating only the part of a waiting song ----------------------------------- */

describe('separating only the part of a waiting song', () => {
  // These are about the rows, not their order: the list is pinned to the order songs run in.
  beforeEach(() => localStorage.setItem(SORT_KEY, 'run'))
  const PART = { start: 2.5, end: 4.5, label: 'bar 2' }
  const SEL = { start: 2.5, end: 4.5 }
  const GRID_BODY = { bpm: 120, downbeat: 0.5, beats_per_bar: 4 }
  const settingOn = () => {
    engineSettings = { ...SETTINGS, separate_selection: true }
  }
  const pause = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

  /** The editor on a waiting song (job w1), drawn again with the song as the engine changes it. */
  function editWaiting(options: Record<string, unknown> = {}, initial: TrimMemory = FRESH, onRange = vi.fn(async (_range: unknown) => undefined)) {
    const props = { initial, instant: false, leaving: false, onBack: vi.fn(), onCommit: vi.fn(async () => undefined), onRange }
    const view = render(tree(<TrimEditor song={songOfJob(waitingJob(options))} {...props} />))
    const redraw = (next: Record<string, unknown>) => view.rerender(tree(<TrimEditor song={songOfJob(waitingJob(next))} {...props} />))
    return { ...view, onRange, redraw }
  }

  it('sets the part once it has settled, named by its grid, and takes it away when cleared', async () => {
    settingOn()
    const { onRange, redraw } = editWaiting({}, { ...FRESH, sel: SEL })
    // Not at once: once the part has come to rest, as a clip is written.
    expect(onRange).not.toHaveBeenCalled()
    await waitFor(() => expect(onRange).toHaveBeenCalledTimes(1))
    expect(onRange).toHaveBeenCalledWith({ ...SEL, grid: GRID_BODY })
    // The footer says what Start will do once the song carries the part, in the engine's words.
    expect(screen.queryByTestId('start-part')).not.toBeInTheDocument()
    redraw({ range: PART })
    expect(screen.getByTestId('start-part')).toHaveTextContent('Start separates only bar 2.')
    await userEvent.click(screen.getByRole('button', { name: 'Clear the selection' }))
    expect(screen.queryByTestId('start-part')).not.toBeInTheDocument()
    await waitFor(() => expect(onRange).toHaveBeenLastCalledWith(null))
    expect(onRange).toHaveBeenCalledTimes(2)
  })

  it('opens on the part the song carries, sends nothing for it, and sets it again once changed', async () => {
    settingOn()
    const { onRange } = editWaiting({ range: PART })
    expect(editorEl()).toHaveAttribute('data-sel', '2.5,4.5')
    expect(screen.getByTestId('start-part')).toHaveTextContent('Start separates only bar 2.')
    await pause(500)
    expect(onRange).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('slider', { name: 'End of the selection' }), { key: 'ArrowRight' })
    expect(editorEl()).toHaveAttribute('data-sel', '2.5,6.5')
    // Until the song carries the new part, the footer does not claim it.
    expect(screen.queryByTestId('start-part')).not.toBeInTheDocument()
    await waitFor(() => expect(onRange).toHaveBeenCalledWith({ start: 2.5, end: 6.5, grid: GRID_BODY }))
  })

  it('sets the part again when a new grid names it differently', async () => {
    settingOn()
    const { onRange, redraw } = editWaiting({ range: PART })
    await pause(450)
    expect(onRange).not.toHaveBeenCalled()
    // The tempo was changed (here, or in the row): the same seconds are beats 1.3 to 2.1 now.
    redraw({ range: PART, bpm: 60, downbeat: 0.5 })
    await waitFor(() => expect(onRange).toHaveBeenCalledWith({ ...SEL, grid: { ...GRID_BODY, bpm: 60 } }))
  })

  it('sets the part at once when the editor is left before it settles', async () => {
    settingOn()
    const { onRange, unmount } = editWaiting({}, { ...FRESH, sel: SEL })
    unmount()
    await waitFor(() => expect(onRange).toHaveBeenCalledWith({ ...SEL, grid: GRID_BODY }))
    expect(onRange).toHaveBeenCalledTimes(1)
  })

  it('says why a part was not set', async () => {
    settingOn()
    const refused = vi.fn(async (_range: unknown) => {
      throw new ApiError('this song has started: its part can no longer change')
    })
    editWaiting({}, { ...FRESH, sel: SEL }, refused)
    expect(await screen.findByText('this song has started: its part can no longer change')).toBeInTheDocument()
    expect(screen.queryByTestId('start-part')).not.toBeInTheDocument()
  })

  it('sends nothing while the setting is off, and says nothing of Start', async () => {
    const { onRange, unmount } = editWaiting({ range: PART })
    // A part kept from when the setting was on is not taken for a selection.
    expect(editorEl()).toHaveAttribute('data-sel', '')
    unmount()
    const again = editWaiting({ range: PART }, { ...FRESH, sel: { start: 4.5, end: 6.5 } })
    await pause(500)
    await userEvent.click(screen.getByRole('button', { name: 'Clear the selection' }))
    await pause(500)
    expect(onRange).not.toHaveBeenCalled()
    expect(again.onRange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('start-part')).not.toBeInTheDocument()
  })

  it("leaves a separated song's stems alone", async () => {
    settingOn()
    const onRange = vi.fn(async () => undefined)
    openEditor({ initial: { ...FRESH, sel: SEL }, onRange })
    await pause(500)
    expect(onRange).not.toHaveBeenCalled()
    expect(screen.queryByTestId('start-part')).not.toBeInTheDocument()
  })

  it('says on a waiting row that Start separates only the part, while the setting is on', () => {
    const ranged = waitingJob({ range: { start: 2.5, end: 18.5, label: 'bars 2-9' } })
    expect(statusText(ranged, true)).toBe('Ready to start, bars 2-9 only')
    expect(statusText(ranged)).toBe('Ready to start')
    expect(statusText({ ...ranged, held: false, queue_position: 2 }, true)).toBe('Queued, 2 ahead, bars 2-9 only')
    expect(statusText(waitingJob(), true)).toBe('Ready to start')
    // Once it has started, the part is what runs: the row says what is happening instead.
    expect(statusText({ ...ranged, state: 'running', message: 'Separating vocals' }, true)).toBe('Separating vocals')
    expect(jobRange({ state: 'queued', options: { range: { start: 3, end: 1, label: 'x' } } })).toBeNull()

    settingOn()
    jobs = [ranged, waitingJob()]
    render(
      tree(
        <SelectionProvider settings={engineSettings}>
          <QueueView recipes={[]} models={[]} selectedJob={null} onSelect={vi.fn()} onAddFiles={vi.fn()} onPasteLink={vi.fn()} />
        </SelectionProvider>,
      ),
    )
    expect(screen.getAllByTestId('job-status').map((status) => status.textContent)).toEqual(['Ready to start, bars 2-9 only', 'Ready to start'])
  })

  it('is a switch in Settings, off by default', async () => {
    render(tree(<SettingsView recipes={[]} />))
    const toggle = screen.getByRole('switch', { name: 'Separate only the trimmed part' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/Start separates just that part: faster, and its stems come out trimmed\./)).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(patchSettings.mutate).toHaveBeenCalledWith({ separate_selection: true }, expect.anything())
  })
})
