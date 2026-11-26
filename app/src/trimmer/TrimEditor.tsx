/**
 * The clip editor: one song at a time, in place of the main area (the sidebar stays). What to
 * trim is chosen in the top bar, the grid is fixed in the toolbar and the ruler, a part is
 * chosen on the waveform, and the part is dragged out from the footer (docs/adr/0023-trimmer.md).
 *
 * The grid is the song's own: fixing it here sets the song's tempo and bar 1 everywhere,
 * through the same retag as the tempo field, once a gesture ends (never on every frame).
 */

import { useQueries } from '@tanstack/react-query'
import { ArrowLeft, AudioLines, GripVertical, Layers, Metronome, Pause, Play, Redo2, Repeat, RotateCcw, SkipBack, TriangleAlert, Undo2, X } from 'lucide-react'
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { type Peaks, fileUrl, unwrap } from '@/api/client'
import { useEngine } from '@/api/engine'
import { type NewJobRange, useSettings, useSourcePreview } from '@/api/queries'
import { type PeaksPart, PeaksWave, type Pyramid, type WaveLayer, type WaveSource, pyramidOf, readyPyramid, sharedGain } from '@/audio/pyramid'
import { type TrimTrack, TrimPlayer } from '@/audio/trimplayer'
import { useToast } from '@/components/toast'
import { Button, CommitInput, IconButton, Segmented, Tooltip } from '@/components/ui'
import { cn, stemColor } from '@/lib/format'
import {
  type Grid,
  type Range,
  SNAPS,
  SNAP_LABEL,
  type Snap,
  TAP_RESET_MS,
  TapTempo,
  type View,
  cleanDownbeat,
  cleanRange,
  double,
  fitView,
  formatClock,
  formatPosition,
  halve,
  panView,
  rangeLabel,
  shiftDownbeat,
  withDownbeat,
} from '@/lib/grid'
import { dragSource } from '@/lib/sourcedrag'
import { formatBpm, parseBpm } from '@/lib/tempokey'
import { type Theme, useTheme } from '@/lib/theme'
import { freeKey, homeKey, isMac, modClick, modKey, modName, redoShortcut, shortcut } from '@/platform'
import { type ClipFiles, SETTLE_MS, forgetWritten, useClipFiles } from '@/state/clip'
import { capitalize } from '@/state/mix'
import { type Tokens, mixColors, useFrame, useTokens } from './canvas'
import { EMPTY, type History, type Moment, type What, figuresChange, nextWhat, record, redo as redoStep, sameRange, undo as undoStep } from './history'
import { type TrimMemory, remember } from './memory'
import {
  BAR_LENGTHS,
  type Chip,
  ORIGINAL,
  type Pick,
  type Target,
  audibleOf,
  barsOf,
  barsRange,
  choose,
  clipNameParts,
  clipRequest,
  clipsFolder,
  clock,
  defaultPick,
  folderOf,
  folderParts,
  isChosen,
  loadBars,
  parseBars,
  parseClock,
  peaksOf,
  readout,
  sameGrid,
  saveBars,
  sectionsOf,
  stemTrack,
  targetOf,
  targetTitle,
  validPick,
  wholeNear,
} from './model'
import { type Figures, type GridChange, type SongGrid, type TrimSong, gridChange, moveRange, resetChange, songGrid, songSeconds } from './song'
import { Overview, Stage, type WaveLayers, seekTo } from './Stage'

export interface TrimEditorProps {
  song: TrimSong
  /** How the song was left last time, and what to show first (the panel's choice, say). */
  initial: TrimMemory
  /** Opened from the keyboard: it appears at once. */
  instant: boolean
  /** On its way out: what it covered is already there under it. */
  leaving: boolean
  /** Back to where it was opened from; `instant` when the keyboard asked. */
  onBack: (instant: boolean) => void
  /**
   * Save the song's tempo and bar 1, as the tempo field does. Resolves once the song shows
   * them; a failure's sentence is toasted and the saved grid comes back.
   */
  onCommit: (change: GridChange) => Promise<unknown>
  /**
   * Choose the part of a waiting song that Start separates alone, or take it away with null:
   * used only while the separate_selection setting is on. Resolves once the song shows it; a
   * failure's sentence is toasted. Absent where the song is not a job in the queue.
   */
  onRange?: (range: NewJobRange) => Promise<unknown>
}

/** A part as the engine is asked for it, by its times and the name the grid gives it. */
const partKey = (r: Range, label: string) => `${r.start}|${r.end}|${label}`
const NO_PART = 'none'

const HINT_NONE = 'No tempo was found in this song. Type it, or tap along with T.'
const HINT_FIRST = 'Grid off? Drag the flag onto the first downbeat, then drag a later bar line onto its beat.'
const HINT_SECOND = 'Bars drift later on? Drag a later bar line onto its beat to set the tempo exactly.'

/** A run of nudges is saved this long after the last one. */
const NUDGE_SAVE_MS = 400

/** A saved grid's draft goes once the song shows it, or after this long in any case. */
const LANDING_MS = 1000

const ALL: Target = { kind: 'all' }

/**
 * The colors of the target: a stem's own, or for the song and a mix of stems a quiet neutral
 * that turns to nearly full ink inside the part. Several stems are drawn each in its own.
 */
function colorsOf(target: Target, theme: Theme, tokens: Tokens): { wave: string; part: string } {
  if (target.kind === 'stem') return { wave: stemColor(target.name, theme), part: stemColor(target.name, theme) }
  if (target.kind === 'group') return { wave: stemColor(target.group, theme), part: stemColor(target.group, theme) }
  // A dense mix in pure ink glares; most of the way from muted to ink reads as bright without it.
  return { wave: tokens.muted, part: mixColors(tokens.text, tokens.muted, 0.78) }
}

/** The engine's coarse peaks of some files, fetched once and shared with the stems panel. */
function usePeaksFiles(paths: (string | null)[]): (Peaks | undefined)[] {
  const { api } = useEngine()
  const results = useQueries({
    queries: paths.map((path) => ({
      queryKey: ['peaks', path],
      enabled: Boolean(path),
      staleTime: Number.POSITIVE_INFINITY,
      queryFn: () => unwrap(api.GET('/v1/peaks', { params: { query: { path: path ?? '' } } })),
    })),
  })
  return results.map((result) => result.data)
}

/** The player for this editor, made once and let go of when the editor goes. */
function useTrimPlayer(tracks: TrimTrack[]) {
  const { connection } = useEngine()
  const player = useMemo(() => new TrimPlayer({ Authorization: `Bearer ${connection.token}` }, window.openstems.info.e2e), [connection.token])
  useEffect(() => () => player.dispose(), [player])
  const subscribe = useCallback((listener: () => void) => player.subscribe(listener), [player])
  const state = useSyncExternalStore(subscribe, () => player.state)
  useEffect(() => player.setTracks(tracks), [player, tracks])
  return { player, state }
}

/**
 * What the waveform's layers are drawn from, each the sum of its tracks: the decoded audio
 * once every track is there, the coarse peaks until then. All of them change together, so
 * the scale they share never jumps from peaks to audio one layer at a time.
 */
function useTargetWaves(player: TrimPlayer, layers: string[][], ready: boolean, placeholders: WaveSource[] | null): WaveSource[] | null {
  const key = JSON.stringify(layers)
  const [built, setBuilt] = useState<{ key: string; waves: Pyramid[] } | null>(null)
  useEffect(() => {
    if (!ready) return
    const groups = (JSON.parse(key) as string[][]).map((ids) => ids.map((id) => player.buffer(id)).filter((buffer): buffer is AudioBuffer => buffer !== null))
    if (groups.length === 0 || groups.some((buffers) => buffers.length === 0)) return
    const known = groups.map((buffers) => readyPyramid(buffers))
    if (known.every((pyramid): pyramid is Pyramid => pyramid !== null)) {
      setBuilt({ key, waves: known })
      return
    }
    let stale = false
    Promise.all(groups.map((buffers) => pyramidOf(buffers))).then(
      (waves) => {
        if (!stale) setBuilt({ key, waves })
      },
      () => undefined,
    )
    return () => {
      stale = true
    }
  }, [player, key, ready])
  return built?.key === key ? built.waves : placeholders
}

/**
 * While the editor is open, toasts rise above its footer: the window's bottom right is where
 * its handles are, and a toast there would take the pointer from them.
 */
function useToastsAbove(footer: RefObject<HTMLElement | null>, shown: boolean): void {
  useEffect(() => {
    const el = footer.current
    if (!shown || !el) return
    const root = document.documentElement
    const lift = () => {
      // The stack's foot sits 8 px above the footer; it is 16 px off the window's foot by itself.
      const above = Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top + 8 - 16))
      root.style.setProperty('--toast-lift', `${above}px`)
    }
    lift()
    const observer = new ResizeObserver(lift)
    observer.observe(el)
    window.addEventListener('resize', lift)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', lift)
      root.style.removeProperty('--toast-lift')
    }
  }, [footer, shown])
}

export function TrimEditor({ song, initial, instant, leaving, onBack, onCommit, onRange }: TrimEditorProps) {
  // Files earlier editors were handed may be gone from disk, or cut from stems separated again
  // since: this editor asks the engine anew, which finds a clip that is still right at once.
  useState(forgetWritten)
  const theme = useTheme()
  const tokens = useTokens(theme)
  const toast = useToast()
  const { connection } = useEngine()
  const { data: settings } = useSettings()
  // With the setting on, a waiting song's part is all that Start separates.
  const separating = Boolean(settings?.separate_selection) && song.waiting && song.jobId !== null && onRange !== undefined
  const preview = useSourcePreview(song.ownFile)
  const previewFigures = useMemo<Figures | null>(
    () => (preview.data ? { bpm: preview.data.analysis.bpm ?? null, downbeat: preview.data.analysis.downbeat ?? null } : null),
    [preview.data],
  )
  const saved = useMemo(() => songGrid(song, previewFigures), [song, previewFigures])

  /* ---- what is trimmed ---- */

  const [chosen, setChosen] = useState<Pick | null>(initial.pick)
  // What was chosen, kept to what the song has now (a waiting song gets its stems later).
  const pick = validPick(song, chosen ?? defaultPick(song))
  const target = useMemo(() => targetOf(song, pick), [song, pick])
  const audible = audibleOf(pick)
  const audibleKey = audible.join('|')
  const label = targetTitle(song, target)

  const tracks = useMemo<TrimTrack[]>(
    () => [
      ...(preview.data ? [{ id: ORIGINAL, label: 'the song', url: fileUrl(connection, preview.data.audio), start: 0 }] : []),
      ...song.stems.map((stem) => ({ id: stemTrack(stem.name), label: stem.name, url: fileUrl(connection, stem.path), start: stem.start })),
    ],
    [preview.data, song.stems, connection],
  )
  const { player, state } = useTrimPlayer(tracks)
  // How long the song is: what the engine said, or else (stems that never said) what was decoded.
  const decodedSeconds = audible.reduce((longest, id) => Math.max(longest, player.buffer(id)?.duration ?? 0), 0)
  const duration = songSeconds(song, preview.data?.duration ?? null) || decodedSeconds
  useEffect(() => player.setDuration(duration), [player, duration])
  // The engine keeps the newest few previews: one made earlier in the session may be gone
  // from its folder. Asked again, it is made again.
  const originalFailed = state.tracks[ORIGINAL]?.state === 'error'
  const remade = useRef<unknown>(null)
  useEffect(() => {
    if (!originalFailed || !preview.data || remade.current === preview.data) return
    remade.current = preview.data
    // The answer is the same as before (the same name for the same file), so the player is
    // told to try again rather than waiting for a change.
    void preview.refetch().then(() => player.load([ORIGINAL]))
  }, [originalFailed, preview, player])

  // Only the chosen target is heard, and it is decoded for drawing as soon as it is chosen.
  useEffect(() => {
    player.setAudible(audibleKey.split('|'))
  }, [player, audibleKey])

  /* ---- the waveform ---- */

  // Several stems are layered, each in its own color, so what plays where can be seen; the
  // song or one stem is one waveform. The parts come in the song's order of stems, as do
  // the layers.
  const placeholderParts = peaksOf(song, pick, preview.data?.peaks ?? null)
  const layerNames = pick.kind === 'stems' && placeholderParts.length > 1 ? song.stems.filter((stem) => pick.names.includes(stem.name)).map((stem) => stem.name) : null
  const layerKey = layerNames?.join('|') ?? ''
  const peaks = usePeaksFiles(placeholderParts.map((part) => part.path))
  const peaksKey = peaks.map((p) => (p ? 1 : 0)).join('')
  const placeholders = useMemo<WaveSource[] | null>(() => {
    const parts: PeaksPart[] = []
    peaks.forEach((p, i) => {
      if (p) parts.push({ peaks: p, start: placeholderParts[i]?.start ?? 0 })
    })
    if (parts.length !== peaks.length || parts.length === 0) return null
    return layerNames ? parts.map((part) => new PeaksWave([part])) : [new PeaksWave(parts)]
    // The peaks are fetched once each; what changes is which are there, and what is chosen.
  }, [peaksKey, audibleKey, layerKey, song.stems])
  const ready = audible.every((id) => state.tracks[id]?.state === 'ready')
  const waves = useTargetWaves(player, layerNames ? layerNames.map((name) => [stemTrack(name)]) : [audible], ready, placeholders)
  // The loudest stretch reaches about three quarters of the height: room above the peaks.
  const gain = useMemo(() => (waves ? sharedGain(waves) * 0.82 : 1), [waves])
  const colors = colorsOf(target, theme, tokens)
  const layers = useMemo<WaveLayers>(() => {
    if (!waves) return { rest: [], part: [] }
    if (layerNames) {
      const each = waves.map((source, i): WaveLayer => ({ source, color: stemColor(layerNames[i] ?? '', theme) }))
      return { rest: each, part: each }
    }
    return { rest: waves.map((source) => ({ source, color: colors.wave })), part: waves.map((source) => ({ source, color: colors.part })) }
    // The names are in the key; the colors are strings.
  }, [waves, layerKey, theme, colors.wave, colors.part])
  const failedTrack = audible.map((id) => state.tracks[id]).find((track) => track?.state === 'error')

  /* ---- the grid: the song's own, saved when a gesture ends ---- */

  const [draft, setDraftState] = useState<Grid | null>(null)
  const grid = draft ?? saved.grid
  const savedRef = useRef<SongGrid>(saved)
  savedRef.current = saved
  const draftRef = useRef<Grid | null>(draft)
  draftRef.current = draft
  // Every change of the draft counts up: a save that ends after a newer change leaves it alone.
  const epoch = useRef(0)
  const setDraft = useCallback((next: Grid | null) => {
    epoch.current += 1
    draftRef.current = next
    setDraftState(next)
  }, [])
  // A save waiting for the last of a run of nudges, or of taps: 0 when none is.
  const nudgeTimer = useRef(0)
  const tapTimer = useRef(0)

  // A save that has ended keeps its draft until the song shows the grid it saved. The song
  // comes from the jobs list, whose cache tells its readers a tick after the save resolves
  // (React Query notifies on a timeout): dropping the draft at once would show the old grid
  // in between, and a gesture then would build on it (two quick Doubles saving twice the old
  // tempo). `landing` is the epoch of such a draft, 0 when none.
  const landing = useRef(0)
  const landingTimer = useRef(0)
  const landed = useCallback(() => {
    landing.current = 0
    window.clearTimeout(landingTimer.current)
    landingTimer.current = 0
    setDraft(null)
  }, [setDraft])
  useEffect(() => {
    const shown = draftRef.current
    if (landing.current !== 0 && landing.current === epoch.current && shown && sameGrid(saved.grid, shown)) landed()
  }, [saved, landed])
  useEffect(() => () => window.clearTimeout(landingTimer.current), [])
  // Saves go one after another: sent at once when none is on its way, else after it. Two at
  // once can reach the engine in either order (its route runs on a pool of threads), and an
  // older one landing last undoes a newer one: a tempo saved with bar 1 pinned where it
  // showed, then bar 1 typed, ended with the old bar 1.
  const onItsWay = useRef<Promise<unknown> | null>(null)

  /* ---- undo and redo: what the grid and the part were before each change ---- */

  // What the song is meant to be saved with, and the grid that draws: a step ahead of the
  // song itself while a save is on its way, and the song's own once nothing is.
  const intended = useRef<Figures>(song.saved)
  const settledGrid = useRef<Grid>(saved.grid)
  if (draft === null && onItsWay.current === null) {
    intended.current = song.saved
    settledGrid.current = saved.grid
  }
  // Steps kept from the last time the song was open are of the timeline it was on then.
  const [history, setHistory] = useState<History>(() => (initial.history && initial.origin === song.origin ? initial.history : EMPTY))
  const historyRef = useRef(history)
  const putHistory = (next: History) => {
    historyRef.current = next
    setHistory(next)
  }
  const selRef = useRef<Range | null>(null)
  const fittedRef = useRef(false)
  // Going back or forward saves a grid too: that save is not itself a step.
  const travelling = useRef(false)
  /** Keep the state before a change that is now complete. */
  const keep = (what: What, selBefore: Range | null) => {
    if (travelling.current) return
    const before: Moment = { figures: intended.current, grid: settledGrid.current, sel: selBefore, fitted: fittedRef.current }
    putHistory(record(historyRef.current, before, what, performance.now()))
  }

  const save = (change: GridChange | null, shown: Grid | null) => {
    window.clearTimeout(nudgeTimer.current)
    nudgeTimer.current = 0
    if (!change) {
      setDraft(null)
      return
    }
    keep('grid', selRef.current)
    intended.current = { ...intended.current, ...change }
    if (shown) settledGrid.current = shown
    setDraft(shown)
    const mine = epoch.current
    const before = onItsWay.current
    const saving = before ? before.then(() => onCommit(change)) : onCommit(change)
    const ended = saving.catch(() => undefined)
    onItsWay.current = ended
    void ended.then(() => {
      if (onItsWay.current === ended) onItsWay.current = null
    })
    saving.then(
      () => {
        if (epoch.current !== mine) return
        if (!shown || sameGrid(savedRef.current.grid, shown)) {
          landed()
          return
        }
        // Until the song shows it; if it never quite does, what was saved is shown after a moment.
        landing.current = mine
        window.clearTimeout(landingTimer.current)
        landingTimer.current = window.setTimeout(() => {
          if (landing.current === mine && epoch.current === mine) landed()
        }, LANDING_MS)
      },
      (error: unknown) => {
        // Put the saved grid back, and say why (a stem open in a DAW stops the renaming).
        if (epoch.current === mine) setDraft(null)
        toast.error(error)
      },
    )
  }
  /** Save `next` as the song's grid; `tempo` when the user meant its tempo. */
  const commit = (next: Grid, tempo: boolean) => {
    const downbeat = cleanDownbeat(next.downbeat)
    const clean = { ...next, downbeat: downbeat.ok && downbeat.value !== null ? downbeat.value : next.downbeat }
    save(gridChange(savedRef.current, clean, tempo), clean)
  }
  /** A step of a run of nudges: shown at once, saved a moment after the last. */
  const nudge = (next: Grid) => {
    setDraft(next)
    window.clearTimeout(nudgeTimer.current)
    nudgeTimer.current = window.setTimeout(() => {
      nudgeTimer.current = 0
      const latest = draftRef.current
      if (latest) commit(latest, false)
    }, NUDGE_SAVE_MS)
  }

  /* ---- what was kept from before ---- */

  // A part kept on another timeline (a waiting song's part, separated alone since) is moved
  // onto this one. A part chosen to be separated alone is shown as the part, when nothing
  // else was left chosen.
  const [sel, setSel] = useState<Range | null>(() => {
    const kept = initial.sel ? moveRange(initial.sel, initial.origin, song.origin, duration) : null
    return kept ?? (separating && song.range ? { start: song.range.start, end: song.range.end } : null)
  })
  const [snap, setSnap] = useState<Snap>(initial.snap)
  const [view, setView] = useState<View>(() => (initial.view && initial.origin === song.origin ? initial.view : { t0: 0, t1: duration }))
  const [fitted, setFitted] = useState(initial.fitted)
  const [click, setClick] = useState(false)
  const [gesture, setGesture] = useState(false)
  // The part as it was before the gesture under way: what tells a new part from a changed one.
  const rest = useRef(sel)
  if (!gesture) rest.current = sel
  selRef.current = sel
  fittedRef.current = fitted

  // A song that comes back on another timeline while it is open (a waiting song whose part
  // was separated alone): the part moves with it, and the view shows the whole of it.
  const origin = useRef(song.origin)
  useEffect(() => {
    const from = origin.current
    if (from === song.origin) return
    origin.current = song.origin
    setSel((current) => (current ? moveRange(current, from, song.origin, duration) : null))
    setView({ t0: 0, t1: duration })
    player.setLoop(null)
  }, [song.origin, duration, player])

  // The song's length can be learnt late (a waiting song's preview) or grow (its own file is
  // a little longer than its stems): a view of the whole song stays the whole song, and a
  // part kept from before stays inside it.
  const lastDuration = useRef(duration)
  useEffect(() => {
    const before = lastDuration.current
    lastDuration.current = duration
    if (duration <= 0) return
    setView((v) => (v.t1 <= v.t0 || v.t1 >= before - 1e-6 || v.t1 > duration ? { t0: Math.min(v.t1 > v.t0 && v.t1 <= duration ? v.t0 : 0, duration), t1: duration } : v))
    setSel((current) => (current && current.end > duration ? cleanRange(current.start, current.end, duration) : current))
  }, [duration])

  const latest = useRef<TrimMemory>({ pick, sel, snap, view, fitted, origin: song.origin, history })
  latest.current = { pick, sel, snap, view, fitted, origin: song.origin, history }
  useEffect(() => () => remember(song.id, latest.current), [song.id])

  const looping = state.loop !== null
  useEffect(() => {
    player.setClick(click ? grid : null)
  }, [player, click, grid])
  useEffect(() => {
    if (leaving) player.pause()
  }, [player, leaving])

  // A keyboard entry skips the entrance; once it has been drawn, the way out may animate again.
  const [arrived, setArrived] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setArrived(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  // The control that opened the editor is gone: focus starts here, so Tab reaches Back first.
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true })
  }, [])

  /* ---- actions, shared by the buttons and the keys ---- */

  const togglePlay = () => player.toggle()
  const toggleLoop = () => {
    if (sel) player.setLoop(looping ? null : sel)
  }
  const playSelection = () => {
    if (sel) player.playRange(sel, looping)
  }
  const clearSelection = () => {
    if (sel) keep('part', sel)
    setSel(null)
    if (looping) player.setLoop(null)
  }
  const keepRef = useRef(keep)
  keepRef.current = keep
  const selectionDone = useCallback(
    (next: Range | null) => {
      // A part chosen where there was none is looped: it is chosen to be heard round and
      // round. After that the loop is the user's: on, it follows the part once the pointer
      // lets go (not on every move); turned off, it stays off.
      const created = next !== null && rest.current === null
      if (!sameRange(rest.current, next)) keepRef.current('part', rest.current)
      rest.current = next
      if (created || player.state.loop) player.setLoop(next)
    },
    [player],
  )
  /** A part of so many bars: the part chosen made that long, or one from the playhead's bar. */
  const selectBars = (bars: number) => {
    const next = barsRange(grid, sel, player.position, bars, duration)
    if (!next) return
    setSel(next)
    selectionDone(next)
    // A part that reaches out of sight is shown whole.
    if (next.start < view.t0 - 1e-6 || next.end > view.t1 + 1e-6) setView(fitView(next, duration))
  }
  /** The playhead and the view go to 0:00. */
  const toStart = () => {
    seekTo(player, 0)
    setView((v) => panView(v, -v.t0, duration))
  }
  const fitSelection = () => {
    if (sel) setView(fitView(sel, duration))
  }
  const wholeSong = () => setView({ t0: 0, t1: duration })

  const tapper = useRef(new TapTempo())
  const [taps, setTaps] = useState(0)
  /** The taps have stopped: the tempo they gave is the song's. */
  const endTaps = () => {
    window.clearTimeout(tapTimer.current)
    tapTimer.current = 0
    setTaps(0)
    tapper.current.reset()
    const tapped = draftRef.current
    if (tapped) {
      setFitted(true)
      commit(tapped, true)
    }
  }
  const tap = () => {
    const bpm = tapper.current.tap(performance.now())
    setTaps(tapper.current.count)
    if (bpm) setDraft({ ...grid, bpm })
    window.clearTimeout(tapTimer.current)
    tapTimer.current = window.setTimeout(endTaps, TAP_RESET_MS)
  }

  // Leaving with a grid change still waiting for its moment (the last nudge, the last tap):
  // it is saved now, so the song keeps the grid the editor showed. Also when the way out
  // starts, so the view coming back under the fade already shows it.
  const flush = useRef<() => void>(() => undefined)
  flush.current = () => {
    const tapped = tapTimer.current !== 0
    if (tapped) {
      endTaps()
      return
    }
    if (nudgeTimer.current === 0) return
    window.clearTimeout(nudgeTimer.current)
    nudgeTimer.current = 0
    const pending = draftRef.current
    if (pending) commit(pending, false)
  }
  useEffect(() => {
    if (leaving) flush.current()
  }, [leaving])
  useEffect(() => () => flush.current(), [])

  /** Show and save a moment of the history: the part at once, the grid through the usual save. */
  const travel = (to: Moment) => {
    setSel(to.sel)
    selRef.current = to.sel
    rest.current = to.sel
    // A loop follows the part, as it does when the part is moved by hand.
    if (player.state.loop) player.setLoop(to.sel)
    setFitted(to.fitted)
    fittedRef.current = to.fitted
    const change = figuresChange(intended.current, to.figures)
    if (!change) return
    travelling.current = true
    save(change, to.grid)
    travelling.current = false
  }
  const here = (): Moment => ({ figures: intended.current, grid: settledGrid.current, sel: selRef.current, fitted: fittedRef.current })
  const undo = () => {
    if (gesture) return
    // A nudge or a tap still waiting for its moment is a change like any other: it is saved
    // first, and is then the step taken back.
    flush.current()
    const step = undoStep(historyRef.current, here())
    if (!step) return
    putHistory(step.history)
    travel(step.to)
  }
  const redo = () => {
    if (gesture) return
    flush.current()
    const step = redoStep(historyRef.current, here())
    if (!step) return
    putHistory(step.history)
    travel(step.to)
  }

  // Keys. Nothing animates for them; none of them acts while a field is being typed in.
  useEffect(() => {
    if (leaving) return
    const onKey = (event: KeyboardEvent) => {
      const el = event.target instanceof Element ? event.target : null
      // In a field, Undo is the field's own: what was typed there.
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="combobox"]')) return
      const key = event.key.toLowerCase()
      if (modKey(event) && !event.altKey && (key === 'z' || key === 'y')) {
        // Ctrl+Z, and Ctrl+Shift+Z or Ctrl+Y to go forward again (Cmd on a Mac).
        event.preventDefault()
        if (key === 'y' || event.shiftKey) redo()
        else undo()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.code === 'Space') {
        // Also on a focused button: Space is the transport here, as in the stems panel.
        event.preventDefault()
        // A held key repeats: one press is one toggle.
        if (!event.repeat) togglePlay()
      } else if (event.repeat) {
        return
      } else if (key === 'l') {
        toggleLoop()
      } else if (key === 't') {
        tap()
      } else if (key === 'f') {
        fitSelection()
      } else if (key === 'z') {
        wholeSong()
      } else if (key === 'home') {
        toStart()
      } else if (key === 'escape') {
        if (sel) {
          const fromEdge = el?.closest('[data-edge]')
          clearSelection()
          // The edge that had the focus is gone with the selection: the waveform takes it.
          if (fromEdge) sectionRef.current?.querySelector<HTMLElement>('[data-testid="trim-wave"]')?.focus()
        } else {
          onBack(true)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /* ---- every frame: the clock ---- */

  const clockRef = useRef<HTMLSpanElement>(null)
  const posRef = useRef<HTMLSpanElement>(null)
  const shown = useRef({ clock: '', pos: '' })
  // While what is chosen is decoded, the line under the clock says how far it is.
  const decoded = audible.filter((id) => state.tracks[id]?.state === 'ready').length
  const loading = audible.some((id) => state.tracks[id]?.state === 'loading')
  useFrame(() => {
    const t = player.position
    const text = clock(t)
    const pos = loading
      ? `loading ${decoded}/${audible.length}`
      : saved.found
        ? `bar ${formatPosition(grid, t).split('.').slice(0, 2).join('.')}`
        : 'no tempo'
    if (text !== shown.current.clock && clockRef.current) clockRef.current.textContent = text
    if (pos !== shown.current.pos && posRef.current) posRef.current.textContent = pos
    shown.current = { clock: text, pos }
  })

  /* ---- what the handles give ---- */

  // A selection on the stand-in grid of a song with no tempo is named by its times.
  const naming = saved.found ? grid : null
  const settled = !gesture && draft === null
  // The main handle wants its file as soon as the part settles: it is what the editor is for.
  const clipFiles = useClipFiles(song.id, clipRequest(song, target, sel, naming), { wanted: true, settled, onError: toast.error })
  // Where clips go: the folder of the clip once it is written, where it will be until then.
  const written = sel && clipFiles.status === 'ready' ? clipFiles.paths[0] : undefined
  const folder = written ? folderOf(written) : clipsFolder(song, target, settings?.output_dir ?? null)

  const untouched = sameGrid(grid, saved.detected)
  const hint = !saved.found && draft === null ? HINT_NONE : untouched ? HINT_FIRST : fitted ? null : HINT_SECOND
  const known = duration > 0

  /* ---- separating only the part: what Start does with a waiting song ---- */

  // The part the job should carry, named as the engine will name it: only once the song's
  // length (and so its grid) is known. Its name is fixed when it is set, so a new grid sets it again.
  const wantedPart = separating && known ? (sel ? partKey(sel, rangeLabel(naming, sel)) : NO_PART) : null
  // What the job was last given; a part it carries already is not sent again.
  const sentPart = useRef(song.range ? partKey(song.range, song.range.label) : NO_PART)
  const pendingPart = useRef<{ key: string; range: NewJobRange } | null>(null)
  // One at a time, in order: two quick changes must not land the wrong way round.
  const partChain = useRef<Promise<unknown>>(Promise.resolve())
  const rangeLatest = useRef({ onRange, toast })
  rangeLatest.current = { onRange, toast }
  const sendPart = useCallback(() => {
    const next = pendingPart.current
    pendingPart.current = null
    const post = rangeLatest.current.onRange
    if (!next || !post) return
    const before = sentPart.current
    sentPart.current = next.key
    partChain.current = partChain.current
      .then(() => post(next.range))
      .catch((error: unknown) => {
        // Not set: the next change asks again. A song that has started says so.
        if (sentPart.current === next.key) sentPart.current = before
        rangeLatest.current.toast.error(error)
      })
  }, [])
  useEffect(() => {
    if (wantedPart === null || !settled || wantedPart === sentPart.current) {
      pendingPart.current = null
      return
    }
    const range: NewJobRange = sel
      ? { start: sel.start, end: sel.end, grid: naming ? { bpm: naming.bpm, downbeat: naming.downbeat, beats_per_bar: naming.beatsPerBar } : null }
      : null
    pendingPart.current = { key: wantedPart, range }
    // As a clip is: once a run of changes (arrow keys on an edge) has come to rest.
    const timer = window.setTimeout(sendPart, SETTLE_MS)
    return () => window.clearTimeout(timer)
    // The key holds the part and its name: the request is read with it.
  }, [wantedPart, settled, sendPart])
  // Back straight after choosing a part still sets it.
  useEffect(() => () => sendPart(), [sendPart])
  // What Start will do, once the job carries this part.
  const startNote = separating && sel && song.range && wantedPart === sentPart.current ? `Start separates only ${song.range.label}.` : null

  const status: ReactNode = (() => {
    if (waves) return null
    if (pick.kind === 'source') {
      if (preview.isError) return <ReadFailed error={preview.error} />
      if (!preview.data) return <Reading />
    }
    if (failedTrack?.state === 'error') return <span role="alert">{failedTrack.error}</span>
    return null
  })()

  const footer = useRef<HTMLDivElement>(null)
  useToastsAbove(footer, known)

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className={cn('trim-editor absolute inset-0 flex flex-col bg-bg', instant && !arrived && 'trim-instant')}
      data-leaving={leaving || undefined}
      aria-label={`Trim ${song.title}`}
      data-testid="trim-editor"
      data-song={song.id}
      data-waiting={song.waiting || undefined}
      data-target={label}
      data-t0={view.t0}
      data-t1={view.t1}
      data-duration={duration}
      data-bpm={grid.bpm}
      data-downbeat={grid.downbeat}
      data-found={saved.found}
      data-sel={sel ? `${sel.start},${sel.end}` : ''}
      data-wave={waves ? (waves.some((source) => source instanceof PeaksWave) ? 'peaks' : 'audio') : 'none'}
    >
      <TopBar
        song={song}
        pick={pick}
        preview={preview}
        onPick={setChosen}
        onBack={onBack}
        undoes={nextWhat(history.past)}
        redoes={nextWhat(history.future)}
        onUndo={undo}
        onRedo={redo}
      />
      {known ? (
        <>
          <GridBar
            song={song}
            grid={grid}
            saved={saved}
            duration={duration}
            snap={snap}
            onSnap={setSnap}
            click={click}
            onClick={() => setClick((on) => !on)}
            taps={taps}
            onTap={tap}
            onTempo={(next, typed) => {
              if (typed) setFitted(true)
              commit(next, true)
            }}
            onEmptyTempo={() => save(song.waiting ? { bpm: null } : { bpm: saved.detectedFigures.bpm }, { ...grid, bpm: saved.detected.bpm })}
            onDownbeat={(next) => commit(next, false)}
            onNudge={nudge}
            sel={sel}
            onBars={selectBars}
            onReset={() => {
              setFitted(false)
              save(resetChange(song, saved), saved.detected)
            }}
            onError={toast.error}
          />

          <div className="flex min-h-0 flex-1 flex-col px-5 pt-3">
            <Stage
              duration={duration}
              layers={layers}
              gain={gain}
              tokens={tokens}
              grid={grid}
              hint={hint}
              status={status}
              onGrid={setDraft}
              onGridDone={(next, tempo) => {
                if (tempo) setFitted(true)
                commit(next, tempo)
              }}
              onGridNudge={nudge}
              view={view}
              onView={setView}
              sel={sel}
              onSel={setSel}
              onSelDone={selectionDone}
              onGesture={setGesture}
              snap={snap}
              player={player}
              playing={state.playing}
              label={label}
            />
            <div className="mt-2.5 flex flex-none items-center gap-3">
              <Tooltip label={`Back to the start (${homeKey()})`}>
                <Button variant="ghost" size="icon" className="-mr-1.5 !h-7 !w-7 flex-none" aria-label="Back to the start" data-testid="trim-start" onClick={toStart}>
                  <SkipBack size={14} fill="currentColor" />
                </Button>
              </Tooltip>
              <Tooltip label={state.playing ? 'Pause (Space)' : 'Play (Space)'}>
                <Button
                  variant="primary"
                  size="icon"
                  className="!h-8 !w-8 flex-none rounded-full"
                  aria-label={state.playing ? 'Pause' : state.waiting ? 'Loading' : 'Play'}
                  data-testid="trim-play"
                  onClick={togglePlay}
                >
                  {state.waiting ? (
                    <span className="spinner !border-t-accent-ink" aria-hidden="true" />
                  ) : state.playing ? (
                    <Pause size={15} fill="currentColor" />
                  ) : (
                    <Play size={15} fill="currentColor" className="ml-0.5" />
                  )}
                </Button>
              </Tooltip>
              <div className="flex w-[84px] flex-none flex-col font-mono text-[12px] leading-tight tabular">
                <span ref={clockRef} className="text-text">
                  0:00.00
                </span>
                <span ref={posRef} className="text-faint">
                  {saved.found ? 'bar 1.1' : 'no tempo'}
                </span>
              </div>
              <Overview duration={duration} layers={layers.rest} gain={gain} view={view} onView={setView} sel={sel} player={player} />
              <div className="flex flex-none items-center gap-0.5">
                <Tooltip label={sel ? 'Show just the selection (F)' : 'Choose a part to show just that'}>
                  <Button size="sm" variant="ghost" aria-disabled={!sel} onClick={fitSelection}>
                    Fit selection
                  </Button>
                </Tooltip>
                <Tooltip label={`Show the whole song (Z). To zoom, hold ${modName()} and scroll${isMac() ? ', or pinch' : ''}.`}>
                  <Button size="sm" variant="ghost" onClick={wholeSong}>
                    Whole song
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>

          <div ref={footer} className="flex flex-none flex-col">
            {/* Every piece has a width of its own at each width of the window, so a part that
                settles, a handle that turns from Preparing to its file, or a note that comes
                moves nothing. Narrow, the buttons keep their icons and names but not their words. */}
            <footer className="@container flex flex-none items-center gap-3 px-5 pt-3">
              <Readout grid={naming} sel={sel} snap={snap} busy={gesture} onClear={clearSelection} />
              <Tooltip label={sel ? 'Loop the selection (L)' : 'Choose a part to loop it'}>
                <Button size="sm" className="press trim-toggle flex-none" aria-pressed={looping} aria-disabled={!sel} data-testid="loop" onClick={toggleLoop}>
                  <Repeat size={13} />
                  <span className="@max-[1000px]:sr-only">Loop</span>
                </Button>
              </Tooltip>
              <Tooltip label={sel ? 'Play the selection once' : 'Choose a part to play it'}>
                <Button size="sm" className="flex-none" aria-disabled={!sel} data-testid="play-selection" onClick={playSelection}>
                  <Play size={12} />
                  <span className="@max-[1000px]:sr-only">Play selection</span>
                </Button>
              </Tooltip>
              <span className="min-w-4 flex-1" />
              <ClipHandle files={clipFiles} target={target} sel={sel} grid={naming} color={colors.part} />
              {song.stems.length > 0 && <AllHandle song={song} sel={sel} grid={naming} settled={settled} onError={toast.error} />}
            </footer>
            <div className="flex min-w-0 flex-none items-center gap-4 px-5 pt-2 pb-3 text-[12px]" data-testid="trim-foot">
              {folder && <FolderLine folder={folder} />}
              {startNote && (
                <span className="ml-auto flex-none text-text" data-testid="start-part">
                  {startNote}
                </span>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="grid flex-1 place-items-center p-8 text-center" data-testid="trim-loading">
          {preview.isError ? <ReadFailed error={preview.error} /> : <Reading />}
        </div>
      )}
    </section>
  )
}

function Reading() {
  return (
    <span className="inline-flex items-center gap-2.5 text-muted" role="status">
      <span className="spinner" aria-hidden="true" />
      Reading the song
    </span>
  )
}

function ReadFailed({ error }: { error: unknown }) {
  const reason = error instanceof Error ? error.message : String(error ?? '')
  return (
    <span className="max-w-[420px] text-muted" role="alert">
      The song could not be read{reason ? `: ${reason}` : '.'}
    </span>
  )
}

/** Where clips land, cut in its middle when it is long: its last two folders always show. */
function FolderLine({ folder }: { folder: string }) {
  const { head, tail } = folderParts(folder)
  return (
    <span className="flex min-w-0 flex-1 text-faint" title={folder}>
      <span className="truncate">Clips go to {head}</span>
      {tail && <span className="max-w-full flex-none truncate">{tail}</span>}
    </span>
  )
}

/* ---- the top bar: back, the song, what to trim ------------------------------------ */

interface TopBarProps {
  song: TrimSong
  pick: Pick
  preview: { isPending: boolean; isError: boolean; error: unknown; data?: unknown }
  onPick: (pick: Pick) => void
  onBack: (instant: boolean) => void
  /** What Undo takes back and Redo brings back, in words; null when there is nothing to. */
  undoes: string | null
  redoes: string | null
  onUndo: () => void
  onRedo: () => void
}

function TopBar({ song, pick, preview, onPick, onBack, undoes, redoes, onUndo, onRedo }: TopBarProps) {
  const theme = useTheme()
  const chip = (c: Chip, text: ReactNode, colorValue: string, options: { strong?: boolean; mark?: ReactNode; title?: string } = {}) => {
    const on = isChosen(pick, c)
    return (
      <button
        type="button"
        className={cn('trim-chip', options.strong && 'font-semibold')}
        aria-pressed={on}
        title={options.title}
        data-chip={c.kind === 'source' ? 'original' : c.kind === 'group' ? `group:${c.group}` : `stem:${c.name}`}
        style={{ '--stem': colorValue } as CSSProperties}
        // Shift adds too, as it does for solo in the stems panel.
        onClick={(event) => onPick(choose(song, pick, c, modKey(event) || event.shiftKey))}
      >
        {options.mark ?? <span className="trim-chip-dot" aria-hidden="true" />}
        {text}
      </button>
    )
  }
  const separated = song.stems.length > 0
  const reading = Boolean(song.ownFile) && !preview.data && !preview.isError
  const readError = preview.isError ? (preview.error instanceof Error ? preview.error.message : 'The song could not be read') : null
  return (
    <header className="trim-top flex flex-none items-center gap-3 border-b border-line py-2.5 pr-5 pl-3">
      <Tooltip label="Back (Esc)">
        <Button size="sm" variant="ghost" className="flex-none" data-testid="trim-back" onClick={(event) => onBack(event.detail === 0)}>
          <ArrowLeft size={14} />
          Back
        </Button>
      </Tooltip>
      {/* Always there, so nothing in the bar moves when the first change is made; with nothing
          to take back they are dimmed and say so. They say what the next step is. */}
      <div className="flex flex-none items-center" role="group" aria-label="Undo and redo">
        <Tooltip label={undoes ? `Undo ${undoes} (${shortcut('Z')})` : `Nothing to undo (${shortcut('Z')})`}>
          <Button size="icon" variant="ghost" className="!h-7 !w-7" aria-label="Undo" aria-disabled={!undoes} data-testid="trim-undo" data-what={undoes ?? undefined} onClick={onUndo}>
            <Undo2 size={14} />
          </Button>
        </Tooltip>
        <Tooltip label={redoes ? `Redo ${redoes} (${redoShortcut()})` : `Nothing to redo (${redoShortcut()})`}>
          <Button size="icon" variant="ghost" className="!h-7 !w-7" aria-label="Redo" aria-disabled={!redoes} data-testid="trim-redo" data-what={redoes ?? undefined} onClick={onRedo}>
            <Redo2 size={14} />
          </Button>
        </Tooltip>
      </div>
      <span className="h-5 w-px flex-none bg-line" aria-hidden="true" />
      {/* The title takes the room it needs, up to a share of the bar; the chips wrap first. */}
      <div className="flex min-w-0 max-w-[40%] flex-none items-baseline gap-2" data-testid="trim-title">
        <h2 className="m-0 min-w-0 truncate font-display text-[15px] font-semibold" title={song.title}>
          {song.title}
        </h2>
        <span className="flex-none text-[12px] text-faint">{song.quality ? `${song.recipe} · ${song.quality}` : song.recipe}</span>
      </div>
      <div
        className="flex min-w-0 flex-1 basis-0 flex-wrap items-center gap-x-1.5 gap-y-2"
        role="group"
        aria-label="What to trim"
        title={separated ? `${modClick()} to mix several stems` : undefined}
      >
        {song.ownFile &&
          chip({ kind: 'source' }, 'Original', 'var(--color-text)', {
            mark: reading ? (
              <span className="spinner trim-chip-spinner" aria-hidden="true" />
            ) : readError ? (
              <TriangleAlert size={11} className="trim-chip-warn flex-none text-danger" aria-hidden="true" />
            ) : undefined,
            title: reading ? 'Reading the song. The first time takes a few seconds.' : (readError ?? undefined),
          })}
        {separated ? (
          <>
            {song.ownFile && <span className="mx-1 h-4 w-px flex-none bg-line" aria-hidden="true" />}
            {sectionsOf(song).map((section) =>
              section.group ? (
                <div key={section.group} className="trim-group" role="group" aria-label={section.group}>
                  {chip({ kind: 'group', group: section.group, parts: section.stems }, capitalize(section.group), stemColor(section.group, theme), { strong: true })}
                  {section.stems.map((name) => (
                    <span key={name} className="contents">
                      {chip({ kind: 'stem', name }, name, stemColor(name, theme))}
                    </span>
                  ))}
                </div>
              ) : (
                section.stems.map((name) => (
                  <span key={name} className="contents">
                    {chip({ kind: 'stem', name }, name, stemColor(name, theme))}
                  </span>
                ))
              ),
            )}
            <ChipsHint>{modClick()} to mix several stems</ChipsHint>
          </>
        ) : (
          <ChipsHint>Single stems can be trimmed once it is separated.</ChipsHint>
        )}
      </div>
    </header>
  )
}

/**
 * A hint after the chips, in the room they leave on their line. It never takes a line of its
 * own: where too little room is left it goes, and the chips' tooltip says it instead.
 */
function ChipsHint({ children }: { children: ReactNode }) {
  return (
    <span className="@container ml-1 block min-w-0 flex-1 basis-0">
      <span className="block truncate text-[12px] text-faint @max-[110px]:hidden">{children}</span>
    </span>
  )
}

/* ---- the grid toolbar ------------------------------------------------------------- */

/** A line between groups, left out where its group starts a line of its own. */
function Divider({ className }: { className?: string }) {
  return <span className={cn('h-5 w-px flex-none bg-line', className)} aria-hidden="true" />
}

/** Where the toolbar breaks onto a new line. */
function Break() {
  return <span className="h-0 basis-full" aria-hidden="true" />
}

/**
 * Where the toolbar's groups break into lines, from the widths they need on this screen:
 * each line takes the groups that fit on it, in their order.
 * Measured rather than set at fixed widths, since the font decides (SF Pro on a Mac is wider
 * than Segoe UI). One for each group but the last: true where a line breaks after it.
 */
function useToolbarBreaks(bar: RefObject<HTMLDivElement | null>, groups: RefObject<HTMLDivElement | null>[]): boolean[] {
  const [breaks, setBreaks] = useState<boolean[]>(() => groups.slice(1).map(() => false))
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const measure = () => {
      const style = getComputedStyle(el)
      const room = el.clientWidth - Number.parseFloat(style.paddingLeft || '0') - Number.parseFloat(style.paddingRight || '0')
      const widths = groups.map((group) => group.current?.offsetWidth ?? 0)
      if (room <= 0 || widths.some((width) => width === 0)) return
      // A divider between two groups on a line: itself, and a gap either side.
      const joint = 2 * (Number.parseFloat(style.columnGap) || 12) + 1
      let line = widths[0] ?? 0
      const after = widths.slice(1).map((width) => {
        const fits = line + joint + width <= room + 0.5
        line = fits ? line + joint + width : width
        return !fits
      })
      setBreaks((before) => (before.length === after.length && before.every((was, i) => was === after[i]) ? before : after))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const group of groups) if (group.current) observer.observe(group.current)
    // The font arrives after the first layout: measure again once it has.
    void document.fonts?.ready.then(measure)
    return () => observer.disconnect()
  }, [bar, groups])
  return breaks
}

/** The words the "was" slot can hold, the widest of each kind: the slot is as wide as the widest. */
const WAS_WORDS = ['detected', 'none found', 'by hand', 'was 888.8']

interface GridBarProps {
  song: TrimSong
  grid: Grid
  saved: SongGrid
  duration: number
  snap: Snap
  onSnap: (snap: Snap) => void
  click: boolean
  onClick: () => void
  taps: number
  onTap: () => void
  /** A new tempo: `typed` when it was typed, which is what the user means, no fit needed. */
  onTempo: (grid: Grid, typed: boolean) => void
  /** The tempo field emptied: back to what was detected. */
  onEmptyTempo: () => void
  /** Bar 1 typed. */
  onDownbeat: (grid: Grid) => void
  /** Bar 1 moved by a button: saved a moment after the last press. */
  onNudge: (grid: Grid) => void
  /** The part chosen, for the length it has. */
  sel: Range | null
  /** A length pressed or typed: a part of so many bars. */
  onBars: (bars: number) => void
  onReset: () => void
  onError: (error: unknown) => void
}

function GridBar({ song, grid, saved, duration, snap, onSnap, click, onClick, taps, onTap, onTempo, onEmptyTempo, onDownbeat, onNudge, sel, onBars, onReset, onError }: GridBarProps) {
  // A refused field is made anew, so it shows the grid's figure again; so is bar 1's once
  // typed in, so "0.25" shows as the time it is.
  const [refused, setRefused] = useState(0)
  const [typed, setTyped] = useState(0)
  const refuse = (message: string) => {
    setRefused((n) => n + 1)
    onError(message)
  }
  const detected = saved.detected
  const changedBpm = Math.abs(grid.bpm - detected.bpm) > 1e-9
  // Where the figure came from: detection until it is changed, then what it was.
  const source = saved.detectedFigures.bpm === null ? (saved.found ? 'by hand' : 'none found') : changedBpm ? `was ${formatBpm(detected.bpm)}` : 'detected'
  // Offered once a tempo has settled (two decimals), never while a bar line is being dragged:
  // it would come and go under the pointer at every whole tempo passed on the way.
  const settledBpm = Math.abs(grid.bpm * 100 - Math.round(grid.bpm * 100)) < 1e-6
  const whole = settledBpm ? wholeNear(grid.bpm) : null
  const changed = !sameGrid(grid, detected)
  const free = freeKey()
  const resetLabel = song.waiting
    ? 'Put back what detection finds'
    : `Put back what was detected: ${saved.detectedFigures.bpm === null ? 'no tempo' : `${formatBpm(detected.bpm)} BPM`}, bar 1 at ${formatClock(detected.downbeat)}`

  const bar = useRef<HTMLDivElement>(null)
  const tempoGroup = useRef<HTMLDivElement>(null)
  const barOneGroup = useRef<HTMLDivElement>(null)
  const partGroup = useRef<HTMLDivElement>(null)
  const restGroup = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => [tempoGroup, barOneGroup, partGroup, restGroup], [])
  const [afterTempo, afterBarOne, afterPart] = useToolbarBreaks(bar, groups)

  // The length typed last is offered again, in the next song too.
  const [ownBars, setOwnBars] = useState(loadBars)
  const length = barsOf(grid, sel)
  const barsLabel = (bars: number) => (sel ? `Make the part ${bars} ${bars === 1 ? 'bar' : 'bars'} long` : `Choose ${bars} ${bars === 1 ? 'bar' : 'bars'} from the playhead`)

  // Everything that comes and goes keeps its place (hidden, not gone), and what appears now
  // and then (Reset, "Use 87") is last, where room left over reads as the end of a line: the
  // bar never changes its number of lines, so the ruler below it never moves under a drag. A
  // divider never ends or starts a line.
  return (
    <div ref={bar} className="trim-toolbar flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-2" role="toolbar" aria-label="Grid">
      <div ref={tempoGroup} className="flex flex-none items-center gap-2">
        <CommitInput
          key={`bpm-${refused}`}
          className="trim-field w-[66px] text-center font-medium tabular"
          inputMode="decimal"
          aria-label="Tempo in BPM"
          title="The song's tempo. Type over it if it is wrong; file names that hold it, and the tempo FL Studio reads, follow."
          // No tempo found: the field is empty, and the stand-in the grid is drawn at is its hint.
          value={saved.found || !sameGrid(grid, saved.grid) ? formatBpm(grid.bpm) : ''}
          placeholder={formatBpm(saved.grid.bpm)}
          data-testid="tempo-field"
          onCommit={(text) => {
            const parsed = parseBpm(text)
            if (!parsed.ok) return refuse(parsed.error)
            if (parsed.value === null) return onEmptyTempo()
            onTempo({ ...grid, bpm: parsed.value }, true)
          }}
        />
        <span className="text-[12px] text-faint" aria-hidden="true">
          BPM
        </span>
        <span className="trim-was text-[12px] text-faint tabular">
          <span data-testid="tempo-was">{source}</span>
          {WAS_WORDS.map((word) => (
            <span key={word} className="invisible" aria-hidden="true">
              {word}
            </span>
          ))}
        </span>
        <div className="trim-joined">
          <Tooltip label={`Half the tempo: ${formatBpm(halve(grid).bpm)} BPM`}>
            <button type="button" className="trim-join-btn pressable" aria-label="Half the tempo" onClick={() => onTempo(halve(grid), false)}>
              Half
            </button>
          </Tooltip>
          <Tooltip label={`Double the tempo: ${formatBpm(double(grid).bpm)} BPM`}>
            <button type="button" className="trim-join-btn pressable" aria-label="Double the tempo" onClick={() => onTempo(double(grid), false)}>
              Double
            </button>
          </Tooltip>
        </div>
        <Tooltip label="Tap along on the beat, or press T. Three taps give a tempo.">
          <Button size="sm" className="press w-[58px] tabular" data-testid="tap" onClick={onTap}>
            {taps > 0 ? `Tap ${taps}` : 'Tap'}
          </Button>
        </Tooltip>
      </div>

      {afterTempo ? <Break /> : <Divider />}

      <div ref={barOneGroup} className="flex flex-none items-center gap-2">
        <span className="text-[12px] text-faint">Bar 1 at</span>
        <div className="trim-joined">
          <Tooltip label="A beat earlier">
            <button type="button" className="trim-join-btn pressable" data-testid="downbeat-beat-earlier" onClick={() => onNudge(shiftDownbeat(grid, -1))}>
              −1 beat
            </button>
          </Tooltip>
          <Tooltip label="10 ms earlier">
            <button type="button" className="trim-join-btn pressable" data-testid="downbeat-earlier" onClick={() => onNudge(withDownbeat(grid, grid.downbeat - 0.01))}>
              −10 ms
            </button>
          </Tooltip>
          <CommitInput
            key={`downbeat-${refused}-${typed}`}
            className="trim-join-field font-mono tabular"
            aria-label="Where bar 1 starts"
            title="Where bar 1 starts, in minutes and seconds. Type over it, or drag the flag in the ruler."
            value={formatClock(grid.downbeat)}
            data-testid="downbeat-field"
            // The field shows milliseconds and bar 1 is kept to a tenth of one: Enter on what it
            // shows puts bar 1 there.
            commitUnchanged
            onCommit={(text) => {
              const t = parseClock(text)
              if (t === null || t > duration) return refuse(`Type a time in the song, such as ${formatClock(detected.downbeat)}.`)
              const clean = cleanDownbeat(t)
              if (!clean.ok) return refuse(clean.error)
              setTyped((n) => n + 1)
              if (clean.value !== null && Math.abs(clean.value - grid.downbeat) > 1e-9) onDownbeat(withDownbeat(grid, clean.value))
            }}
          />
          <Tooltip label="10 ms later">
            <button type="button" className="trim-join-btn pressable" data-testid="downbeat-later" onClick={() => onNudge(withDownbeat(grid, grid.downbeat + 0.01))}>
              +10 ms
            </button>
          </Tooltip>
          <Tooltip label="A beat later">
            <button type="button" className="trim-join-btn pressable" data-testid="downbeat-beat-later" onClick={() => onNudge(shiftDownbeat(grid, 1))}>
              +1 beat
            </button>
          </Tooltip>
        </div>
        {/* Always there, dimmed while bar 1 is at 0:00 already: nothing moves when it is pressed. */}
        <Tooltip label={grid.downbeat === 0 ? 'Bar 1 is at the start of the song' : 'Put bar 1 at the start of the song'}>
          <Button
            size="sm"
            className="tabular"
            aria-label="Put bar 1 at the start of the song"
            aria-disabled={grid.downbeat === 0}
            data-testid="downbeat-start"
            onClick={() => grid.downbeat !== 0 && onDownbeat(withDownbeat(grid, 0))}
          >
            0:00
          </Button>
        </Tooltip>
      </div>

      {afterBarOne ? <Break /> : <Divider />}

      <div ref={partGroup} className="flex flex-none items-center gap-2">
        <span className="text-[12px] text-faint">Snap</span>
        <Segmented<Snap>
          label="Snap"
          value={snap}
          onChange={onSnap}
          className="trim-snap"
          options={SNAPS.map((value) => ({
            value,
            label: SNAP_LABEL[value],
            hint: value === 'off' ? 'Place freely' : `Snap to ${SNAP_WORDS[value]}. Hold ${free} to place freely.`,
          }))}
        />
        <Divider className="mx-1" />
        <span className="text-[12px] text-faint">Length</span>
        <div className="trim-joined" role="group" aria-label="Length of the part in bars">
          {BAR_LENGTHS.map((bars) => (
            <Tooltip key={bars} label={barsLabel(bars)}>
              <button
                type="button"
                className="trim-join-btn pressable tabular"
                aria-label={`${bars} bars`}
                aria-pressed={length === bars}
                data-testid={`bars-${bars}`}
                onClick={() => onBars(bars)}
              >
                {bars}
              </button>
            </Tooltip>
          ))}
          <CommitInput
            key={`bars-${refused}`}
            className="trim-join-field trim-bars-field tabular"
            inputMode="numeric"
            aria-label="Another length in bars"
            title="Another length in bars: type it and press Enter. It is kept for next time."
            value={ownBars === null ? '' : String(ownBars)}
            placeholder="12"
            data-testid="bars-field"
            // Enter on the length it shows gives the part that length again.
            commitUnchanged
            onCommit={(text) => {
              if (!text.trim()) return
              const bars = parseBars(text)
              if (bars === null) return refuse('Type a number of bars, from 1 to 999.')
              setOwnBars(bars)
              saveBars(bars)
              onBars(bars)
            }}
          />
        </div>
        <span className="text-[12px] text-faint" aria-hidden="true">
          bars
        </span>
      </div>

      {afterPart ? <Break /> : <Divider />}

      <div ref={restGroup} className="flex flex-none items-center gap-2">
        <Tooltip label="A click on every beat, to hear whether the grid sits on the music">
          <Button size="sm" className="press trim-toggle" aria-pressed={click} data-testid="click" onClick={onClick}>
            <Metronome size={13} />
            Click
          </Button>
        </Tooltip>
        {/* In slots of their own width: when they come, nothing moves. */}
        <Divider className={cn('mx-1', !changed && whole === null && 'invisible')} />
        <span className={cn('flex', !changed && 'invisible')} aria-hidden={!changed || undefined}>
          <IconButton label={resetLabel} tabIndex={changed ? 0 : -1} data-testid="grid-reset" onClick={onReset}>
            <RotateCcw size={13} />
          </IconButton>
        </span>
        <span className={cn('trim-whole flex', whole === null && 'invisible')} aria-hidden={whole === null || undefined}>
          <Tooltip label={`The tempo is just beside ${whole ?? ''} BPM. Songs made in a DAW mostly sit on a whole tempo.`}>
            <Button
              size="sm"
              variant="ghost"
              className="!px-1.5 text-accent-fg"
              tabIndex={whole === null ? -1 : 0}
              data-testid="use-whole"
              onClick={() => whole !== null && onTempo({ ...grid, bpm: whole }, false)}
            >
              Use {whole ?? ''}
            </Button>
          </Tooltip>
        </span>
      </div>
    </div>
  )
}

/** What each snap snaps to, in words. */
const SNAP_WORDS: Record<Snap, string> = { bar: 'bars', beat: 'beats', half: 'half beats', quarter: 'quarter beats', off: '' }

/* ---- the footer: the part, hearing it, taking it --------------------------------- */

/**
 * What the part is, in one line, and how to change it under that; with no part, how to
 * choose one. A width of its own at each width of the window. Screen readers are told the
 * part once a gesture ends (`busy` false), not at every step of a drag.
 */
function Readout({ grid, sel, snap, busy, onClear }: { grid: Grid | null; sel: Range | null; snap: Snap; busy: boolean; onClear: () => void }) {
  const free = freeKey()
  const part = sel ? readout(grid, sel) : null
  const said = part ? `${part.where} · ${part.length}` : 'No part chosen'
  const [announced, setAnnounced] = useState(said)
  useEffect(() => {
    if (!busy) setAnnounced(said)
  }, [busy, said])
  // The how-to line in full where there is room, and shorter where there is not.
  const [wide, narrow] = !sel
    ? snap === 'off'
      ? ['Snap is off: the ends go where you let go.', 'Snap is off.']
      : [`Hold ${free} to place freely.`, `Hold ${free} to place freely.`]
    : ['Drag its edges to resize, its middle to move.', 'Drag its edges or its middle.']
  return (
    <div className="trim-readout min-w-0 flex-none" data-testid="readout">
      {part ? (
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate tabular" title={said}>
            <span className="font-medium">{part.where}</span>
            <span className="text-muted"> · {part.length}</span>
          </span>
          <Tooltip label="Clear the selection (Esc)">
            <button type="button" aria-label="Clear the selection" className="trim-clear press grid h-5 w-5 flex-none place-items-center rounded-[5px] text-faint" onClick={onClear}>
              <X size={13} />
            </button>
          </Tooltip>
        </div>
      ) : (
        <div className="truncate font-medium">Drag across the waveform</div>
      )}
      <div className="truncate text-[12px] text-muted" title={wide}>
        <span className="@max-[1060px]:hidden">{wide}</span>
        <span className="hidden @max-[1060px]:inline">{narrow}</span>
      </div>
      <span className="sr-only" role="status">
        {announced}
      </span>
    </div>
  )
}

/** Start the native drag of files, the app's one way: the browser's own drag carries no file. */
function dragOut(event: React.DragEvent, files: ClipFiles, original: boolean): void {
  event.preventDefault()
  if (files.status !== 'ready' || files.paths.length === 0) return
  const [only] = files.paths
  // The song's own file goes the way its title drags it: let go over this window, it is not queued again.
  if (original && only) dragSource(event, only)
  else window.openstems.startDrag(files.paths)
}

interface HandleProps {
  song: TrimSong
  sel: Range | null
  grid: Grid | null
  /** No gesture is under way and the grid is saved: what the handle gives can be written. */
  settled: boolean
  onError: (error: unknown) => void
}

/** The file the editor is for: the part of what is chosen (or the whole of it), named by the engine. */
function ClipHandle({ files, target, sel, grid, color }: { files: ClipFiles; target: Target; sel: Range | null; grid: Grid | null; color: string }) {
  const ready = files.status === 'ready'
  const failed = files.status === 'failed'
  const name = files.names[0] ?? ''
  // A long name gives way in the song's name, never in what the file holds or its part: the
  // stem (or mix) and the range are what tell clips apart.
  const { head, tail } = clipNameParts(name, files.labels[0] ?? '', sel && ready ? rangeLabel(grid, sel) : '')
  // The space before the tail must survive the cut, so it cannot be a collapsible one.
  const shownHead = tail ? head.replace(/ $/, ' ') : head
  const whole = target.kind === 'source' ? 'the whole song' : target.kind === 'stem' ? 'the whole stem' : 'the whole song, as one file'
  const title = ready ? name : failed ? 'Not written' : 'Preparing'
  const sub = ready
    ? sel
      ? 'Drag into your DAW or a folder'
      : `No part chosen: ${whole}`
    : failed
      ? 'Press to try again'
      : sel
        ? 'Writing the clip'
        : 'Writing the file'
  return (
    <Tooltip label={ready ? name : failed ? 'The clip was not written. Press to try again.' : 'Writing the file. It can be dragged in a moment.'}>
      <div
        draggable={ready}
        role="button"
        tabIndex={0}
        aria-disabled={!ready && !failed}
        aria-busy={files.status === 'preparing'}
        aria-label={ready ? `Drag ${name}` : failed ? 'Try writing the clip again' : 'Preparing the clip'}
        data-testid="clip-handle"
        data-state={files.status}
        data-paths={JSON.stringify(files.paths)}
        className={cn('clip-handle clip-handle-main flex-none', ready ? 'pressable stem-handle' : failed ? 'pressable' : 'clip-handle-busy', sel && 'clip-handle-part')}
        style={{ '--stem': color } as CSSProperties}
        onDragStart={(event) => dragOut(event, files, target.kind === 'source' && !sel)}
        onClick={() => failed && files.retry()}
        onKeyDown={(event) => {
          if (failed && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            event.stopPropagation()
            files.retry()
          }
        }}
      >
        <GripVertical size={14} className="flex-none text-faint" aria-hidden="true" />
        <span className="clip-glyph" aria-hidden="true">
          {ready ? <AudioLines size={15} /> : failed ? <TriangleAlert size={15} /> : <span className="spinner" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 font-medium" data-testid="clip-name">
            <span className="truncate">{ready ? shownHead : title}</span>
            {/* What the file holds and its part never give way to the name before them: they
                are cut only when they are wider than the whole handle. */}
            {ready && tail && <span className="max-w-full flex-none truncate">{tail}</span>}
          </span>
          <span className="block truncate text-[11.5px] text-muted @max-[1000px]:hidden">{sub}</span>
        </span>
      </div>
    </Tooltip>
  )
}

/**
 * Every stem cut to the part, one file each: written only for the part the pointer or the
 * focus reached it on, so trying other parts writes nothing more.
 */
function AllHandle({ song, sel, grid, settled, onError }: HandleProps) {
  const request = useMemo(() => clipRequest(song, ALL, sel, grid), [song, sel, grid])
  const asked = JSON.stringify(request)
  const [reached, setReached] = useState<string | null>(null)
  const handle = useRef<HTMLDivElement>(null)
  const want = () => setReached(asked)
  // Still under the pointer, or holding the focus, when the part changes: it wants the new one.
  useEffect(() => {
    const el = handle.current
    if (!el) return
    let here = el === document.activeElement
    try {
      here ||= el.matches(':hover')
    } catch {
      // A page that cannot say: the next time the pointer comes is soon enough.
    }
    if (here) setReached(asked)
  }, [asked])
  const files = useClipFiles(song.id, request, { wanted: reached === asked, settled, onError })
  const ready = files.status === 'ready'
  const busy = files.status === 'preparing'
  const count = song.stems.length
  return (
    <Tooltip label={sel ? `Every stem cut to this part, one file each${files.names[0] ? `: ${files.names[0]} and the rest` : ''}` : 'Drag every stem into your DAW or a folder'}>
      <div
        ref={handle}
        draggable={ready}
        role="button"
        tabIndex={0}
        aria-disabled={!ready}
        aria-busy={busy}
        aria-label={sel ? `Drag every stem, this part: ${count} files` : `Drag all ${count} stems`}
        data-testid="all-handle"
        data-state={files.status}
        data-paths={JSON.stringify(files.paths)}
        className={cn('clip-handle clip-handle-all flex-none', ready ? 'pressable stem-handle' : busy ? 'clip-handle-busy' : '')}
        onPointerEnter={want}
        onFocus={want}
        onDragStart={(event) => dragOut(event, files, false)}
        onClick={() => files.status === 'failed' && files.retry()}
      >
        <GripVertical size={14} className="flex-none text-faint" aria-hidden="true" />
        <span className="clip-glyph clip-glyph-plain" aria-hidden="true">
          {busy ? <span className="spinner" /> : <Layers size={15} />}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {sel ? (
              <>
                <span className="@max-[1000px]:hidden">Every stem, this part</span>
                <span className="hidden @max-[1000px]:inline">Every stem</span>
              </>
            ) : (
              'Every stem'
            )}
          </span>
          <span className="block truncate text-[11.5px] text-muted @max-[1000px]:hidden">{busy ? `Writing ${count} clips` : `${count} files, one per stem`}</span>
        </span>
      </div>
    </Tooltip>
  )
}
