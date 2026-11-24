/**
 * The editor's stage: a ruler that fixes the grid, one large waveform that takes the
 * selection, and the overview of the whole song that moves and zooms the view.
 *
 * What changes every frame (the playheads, the pointer's ghost line) is set on the elements
 * themselves; the canvases redraw at most once a frame.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { type WaveLayer, drawLayers } from '@/audio/pyramid'
import type { TrimPlayer } from '@/audio/trimplayer'
import { cn } from '@/lib/format'
import {
  type Grid,
  type GridLine,
  MIN_SPAN,
  type Range,
  type Snap,
  type View,
  beatSeconds,
  cleanBpm,
  fitBar,
  formatClock,
  formatPosition,
  gridLines,
  panView,
  timeAtBar,
  withDownbeat,
  zoomView,
} from '@/lib/grid'
import { formatBpm } from '@/lib/tempokey'
import { isMac } from '@/platform'
import { type Tokens, useCanvas, useFrame, useWidth } from './canvas'
import { barRange, isZoomWheel, moved, nudgeDownbeat, nudgeEdge, placed, spanned, zoomFactor } from './model'

/** How near (px) the pointer must be to a line or an edge to take hold of it. */
const GRAB = 6
/** How far (px) the pointer moves before a press becomes a drag. */
const SLOP = 3

/** Play from `t`. A loop that does not hold `t` is let go first, or the player would jump back into it. */
function seekTo(player: TrimPlayer, t: number): void {
  const loop = player.state.loop
  if (loop && (t < loop.start || t >= loop.end)) player.setLoop(null)
  player.seek(t)
}

/** A canvas showing `t0`..`t1` of a waveform, or of several layered; nothing while there is nothing to draw. */
function Wave({
  layers,
  t0,
  t1,
  gain = 1,
  className,
  style,
}: {
  layers: readonly WaveLayer[]
  t0: number
  t1: number
  gain?: number
  className?: string
  style?: CSSProperties
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useCanvas(
    canvas,
    (ctx, w, h) => {
      if (t1 > t0) drawLayers(ctx, layers, 0, 0, w, h, { t0, t1, gain })
    },
    [layers, t0, t1, gain],
  )
  return <canvas ref={canvas} className={className} style={{ display: 'block', ...style }} aria-hidden="true" />
}

/* ---- the stage: ruler and waveform ------------------------------------------------ */

/** A waveform's layers outside the part, and inside it. */
export interface WaveLayers {
  rest: readonly WaveLayer[]
  part: readonly WaveLayer[]
}

interface StageProps {
  duration: number
  /**
   * What the waveform is drawn from (the decoded audio, or its coarse peaks until then): one
   * layer for the song or a stem, one a stem in its own color when several are chosen. Its
   * colors outside the part and inside it.
   */
  layers: WaveLayers
  gain: number
  tokens: Tokens
  grid: Grid
  /** What the ruler says about fixing the grid, until it is fixed. */
  hint: string | null
  /** Said over the waveform when there is none to show: being read, or why not. */
  status: ReactNode
  /** The grid as it changes under the pointer. */
  onGrid: (grid: Grid) => void
  /** The flag or a bar line was let go: save the grid. `tempo` when a bar line set the tempo. */
  onGridDone: (grid: Grid, tempo: boolean) => void
  /** Bar 1 moved by a key: saved a moment after the last one. */
  onGridNudge: (grid: Grid) => void
  view: View
  onView: (view: View) => void
  sel: Range | null
  /** The selection as it changes under the pointer. */
  onSel: (sel: Range | null) => void
  /** The pointer let go of the selection, or a key moved an edge: what loops follows it now. */
  onSelDone: (sel: Range | null) => void
  /** A drag of the selection or the grid is in progress: nothing is written until it ends. */
  onGesture: (busy: boolean) => void
  snap: Snap
  player: TrimPlayer
  playing: boolean
  label: string
}

type Hold = { kind: 'flag' } | { kind: 'bar'; bar: number }

type RulerDrag = { kind: 'downbeat'; grab: number; from: Grid } | { kind: 'fit'; bar: number; grab: number; from: Grid } | { kind: 'scrub' }

type WaveDrag =
  | { kind: 'create'; origin: number; x0: number; moved: boolean }
  | { kind: 'edge'; fixed: number; x0: number; moved: boolean }
  | { kind: 'move'; from: Range; origin: number; x0: number; moved: boolean }

export function Stage(props: StageProps) {
  const { duration, layers, gain, tokens, grid, hint, status, onGrid, onGridDone, onGridNudge, view, onView, sel, onSel, onSelDone, onGesture, snap, player, playing, label } = props
  const stage = useRef<HTMLDivElement>(null)
  const wave = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const rulerCanvas = useRef<HTMLCanvasElement>(null)
  const gridCanvas = useRef<HTMLCanvasElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const headCap = useRef<HTMLDivElement>(null)
  const ghost = useRef<HTMLDivElement>(null)
  const ghostTag = useRef<HTMLDivElement>(null)
  const width = useWidth(wave)

  const span = view.t1 - view.t0
  const pps = width > 0 && span > 0 ? width / span : 0
  const xOf = (t: number) => (t - view.t0) * pps
  const tOf = (x: number) => view.t0 + (pps > 0 ? x / pps : 0)

  const lines = useMemo<GridLine[]>(() => (pps > 0 ? gridLines(grid, view.t0 - 1 / pps, view.t1 + 1 / pps, pps, 6, 30) : []), [grid, view.t0, view.t1, pps])

  // The latest values, for handlers that run between renders.
  const live = useRef({ grid, sel, view })
  live.current.view = view
  const setGrid = (next: Grid) => {
    live.current.grid = next
    onGrid(next)
  }
  const setSel = (next: Range | null) => {
    live.current.sel = next
    onSel(next)
  }
  useEffect(() => {
    live.current.grid = grid
    live.current.sel = sel
  }, [grid, sel])

  /* ---- drawing ---- */

  useCanvas(
    gridCanvas,
    (ctx, w, h) => {
      ctx.fillStyle = tokens.text
      for (const line of lines) {
        const x = Math.round(xOf(line.t))
        if (x < -1 || x > w + 1) continue
        ctx.globalAlpha = line.kind === 'bar' ? (line.bar === 1 ? 0.5 : 0.17) : line.kind === 'beat' ? 0.08 : 0.04
        ctx.fillRect(x, 0, 1, h)
      }
      ctx.globalAlpha = 0.07
      ctx.fillRect(0, Math.round(h / 2), w, 1)
      ctx.globalAlpha = 1
    },
    [lines, tokens, width, view.t0, view.t1],
  )

  useCanvas(
    rulerCanvas,
    (ctx, w, h) => {
      const lane = 18
      ctx.font = `11px ${tokens.font}`
      ctx.textBaseline = 'alphabetic'
      // Zoomed in far enough, the beats carry numbers too: "24.3" is bar 24, beat 3.
      const beatsLabeled = beatSeconds(grid) * pps >= 56
      for (const line of lines) {
        const x = Math.round(xOf(line.t))
        if (x < -40 || x > w + 1) continue
        ctx.fillStyle = tokens.muted
        if (line.kind === 'bar') {
          ctx.globalAlpha = line.labeled ? 0.55 : 0.3
          const top = line.labeled ? lane : h - 9
          ctx.fillRect(x, top, 1, h - top)
          if (line.labeled && line.bar !== 1) {
            ctx.globalAlpha = 1
            ctx.fillText(String(line.bar), x + 4, lane + 12)
          }
        } else {
          ctx.globalAlpha = line.kind === 'beat' ? 0.35 : 0.2
          const length = line.kind === 'beat' ? (beatsLabeled ? 12 : 6) : 3
          ctx.fillRect(x, h - length, 1, length)
          if (line.kind === 'beat' && beatsLabeled) {
            const beat = Math.round((line.t - grid.downbeat) / beatSeconds(grid))
            const inBar = ((beat % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar
            ctx.fillStyle = tokens.faint
            ctx.globalAlpha = 1
            ctx.fillText(`${line.bar}.${inBar + 1}`, x + 4, lane + 12)
          }
        }
      }
      ctx.globalAlpha = 1
    },
    [lines, tokens, width, view.t0, view.t1, grid],
  )

  /* ---- every frame: the playhead, and paging along with it ---- */

  const last = useRef(0)
  useFrame(() => {
    const position = player.position
    const v = live.current.view
    const w = wave.current?.clientWidth ?? 0
    const x = v.t1 > v.t0 ? ((position - v.t0) / (v.t1 - v.t0)) * w : 0
    const inside = x >= -1 && x <= w + 1
    for (const el of [head.current, headCap.current]) {
      if (!el) continue
      el.style.transform = `translateX(${x}px)`
      el.style.opacity = inside ? '1' : '0'
    }
    // Playing past the right edge turns the page, as a DAW does. Only when the playhead was
    // on screen: a view the user moved elsewhere stays where they put it.
    if (playing && v.t1 - v.t0 < duration - 0.01 && position > v.t1 && last.current <= v.t1 && last.current >= v.t0) {
      onView(panView(v, position - (v.t1 - v.t0) * 0.04 - v.t0, duration))
    }
    last.current = position
  })

  /* ---- zoom and pan with the wheel ---- */

  useEffect(() => {
    const el = stage.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      const box = wave.current?.getBoundingClientRect()
      if (!box || box.width === 0) return
      event.preventDefault()
      const v = live.current.view
      let next: View
      const mac = isMac()
      if (isZoomWheel(event, mac)) {
        const at = v.t0 + ((event.clientX - box.left) / box.width) * (v.t1 - v.t0)
        next = zoomView(v, at, zoomFactor(event, mac), duration)
      } else {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
        next = panView(v, (delta / box.width) * (v.t1 - v.t0), duration)
      }
      // A trackpad sends several events a frame: each builds on the last, not on the last render.
      live.current.view = next
      onView(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [duration, onView])

  /* ---- the ruler: bar 1's flag moves the grid, any other bar line stretches it ---- */

  const [hover, setHover] = useState<Hold | null>(null)
  const [held, setHeld] = useState<Hold | null>(null)
  const rulerDrag = useRef<RulerDrag | null>(null)
  const active = held ?? hover

  const flagX = xOf(grid.downbeat)

  const holdAt = (x: number, target: EventTarget | null): Hold | null => {
    if ((target as HTMLElement | null)?.closest?.('.trim-flag')) return { kind: 'flag' }
    if (Math.abs(x - flagX) <= GRAB) return { kind: 'flag' }
    let best: Hold | null = null
    let distance = GRAB
    for (const line of lines) {
      if (line.kind !== 'bar' || line.bar <= 1) continue
      const d = Math.abs(xOf(line.t) - x)
      if (d <= distance) {
        distance = d
        best = { kind: 'bar', bar: line.bar }
      }
    }
    return best
  }

  const sameHold = (a: Hold | null, b: Hold | null) =>
    a === b || (a !== null && b !== null && a.kind === b.kind && (a.kind === 'flag' || (b.kind === 'bar' && a.bar === b.bar)))

  const rulerX = (event: { clientX: number }) => event.clientX - (ruler.current?.getBoundingClientRect().left ?? 0)

  const onRulerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pps <= 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const x = rulerX(event)
    const t = tOf(x)
    const hold = holdAt(x, event.target)
    if (hold?.kind === 'flag') {
      rulerDrag.current = { kind: 'downbeat', grab: t - grid.downbeat, from: grid }
      setHeld(hold)
      onGesture(true)
    } else if (hold?.kind === 'bar') {
      rulerDrag.current = { kind: 'fit', bar: hold.bar, grab: t - timeAtBar(grid, hold.bar), from: grid }
      setHeld(hold)
      onGesture(true)
    } else {
      rulerDrag.current = { kind: 'scrub' }
      seekTo(player, Math.min(duration, Math.max(0, placed(grid, t, snap, event.altKey))))
    }
  }

  const onRulerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const x = rulerX(event)
    const drag = rulerDrag.current
    if (!drag) {
      const hold = holdAt(x, event.target)
      if (!sameHold(hold, hover)) setHover(hold)
      event.currentTarget.style.cursor = hold ? (hold.kind === 'flag' ? 'grab' : 'ew-resize') : ''
      return
    }
    const t = tOf(x)
    if (drag.kind === 'downbeat') setGrid(withDownbeat(drag.from, t - drag.grab))
    else if (drag.kind === 'fit') setGrid(fitBar(drag.from, drag.bar, t - drag.grab))
    // Scrubbing moves a paused playhead; a playing one would restart every source per move.
    else if (!playing) seekTo(player, Math.min(duration, Math.max(0, placed(grid, t, snap, event.altKey))))
  }

  const onRulerUp = () => {
    const drag = rulerDrag.current
    rulerDrag.current = null
    setHeld(null)
    if (!drag || drag.kind === 'scrub') return
    const current = live.current.grid
    // The drag follows the pointer exactly; the tempo is kept as the app keeps it.
    const done = drag.kind === 'fit' ? { ...current, bpm: cleanBpm(current.bpm) } : current
    setGrid(done)
    onGesture(false)
    onGridDone(done, drag.kind === 'fit' && done.bpm !== drag.from.bpm)
  }

  const onFlagKey = (event: React.KeyboardEvent) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!direction) return
    // The arrows belong to this slider here, not to whatever else listens for them.
    event.preventDefault()
    event.stopPropagation()
    const next = withDownbeat(grid, nudgeDownbeat(grid, direction, event.shiftKey))
    live.current.grid = next
    onGridNudge(next)
  }

  const showDownbeat = () => {
    onView(panView(view, grid.downbeat - span * 0.1 - view.t0, duration))
  }

  /* ---- the waveform: select, resize, move, seek ---- */

  const waveDrag = useRef<WaveDrag | null>(null)
  const xs = sel ? xOf(sel.start) : 0
  const xe = sel ? xOf(sel.end) : 0

  const zoneAt = (x: number): 'start' | 'end' | 'body' | null => {
    if (!sel) return null
    const ds = Math.abs(x - xs)
    const de = Math.abs(x - xe)
    if (Math.min(ds, de) <= GRAB) return ds <= de ? 'start' : 'end'
    return x > xs && x < xe ? 'body' : null
  }

  const waveX = (event: { clientX: number }) => event.clientX - (wave.current?.getBoundingClientRect().left ?? 0)

  const showGhost = (x: number | null, text = '') => {
    const line = ghost.current
    const tag = ghostTag.current
    if (!line || !tag) return
    if (x === null || x < 0 || x > width) {
      line.style.opacity = '0'
      tag.style.opacity = '0'
      return
    }
    line.style.opacity = '1'
    line.style.transform = `translateX(${x}px)`
    tag.style.opacity = '1'
    tag.textContent = text
    // Near the right edge the tag sits on the line's left.
    tag.style.transform = x > width - 90 ? `translateX(calc(${x - 5}px - 100%))` : `translateX(${x + 5}px)`
  }

  // A zoom, a pan or a new grid moves everything under a resting pointer: its ghost would
  // point at the wrong place until it moves again. (The ghost is set on the element, so the
  // effect names what moves it rather than what it reads.)
  useEffect(() => showGhost(null), [view.t0, view.t1, grid, snap])

  const positionText = (t: number, free: boolean) => (free || snap === 'off' ? formatClock(t) : formatPosition(grid, t))

  const endWaveDrag = () => {
    if (waveDrag.current) onGesture(false)
    waveDrag.current = null
  }

  const onWaveDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pps <= 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const x = waveX(event)
    const t = Math.min(duration, Math.max(0, tOf(x)))
    const free = event.altKey
    onGesture(true)
    if (event.shiftKey) {
      // Shift+click reaches out from the selection, or from the playhead, to here.
      const at = placed(grid, t, snap, free)
      const from = sel ? (Math.abs(at - sel.start) < Math.abs(at - sel.end) ? sel.end : sel.start) : placed(grid, player.position, snap, free)
      const next = spanned(grid, from, at, 'off', true, duration)
      if (next) setSel(next)
      waveDrag.current = { kind: 'edge', fixed: from, x0: x, moved: true }
      return
    }
    const zone = zoneAt(x)
    if ((zone === 'start' || zone === 'end') && sel) {
      waveDrag.current = { kind: 'edge', fixed: zone === 'start' ? sel.end : sel.start, x0: x, moved: false }
    } else if (zone === 'body' && sel) {
      waveDrag.current = { kind: 'move', from: sel, origin: t, x0: x, moved: false }
      event.currentTarget.style.cursor = 'grabbing'
    } else {
      waveDrag.current = { kind: 'create', origin: t, x0: x, moved: false }
    }
  }

  const onWaveMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const x = waveX(event)
    const t = Math.min(duration, Math.max(0, tOf(x)))
    const free = event.altKey
    const drag = waveDrag.current
    if (!drag) {
      const zone = zoneAt(x)
      event.currentTarget.style.cursor = zone === 'start' || zone === 'end' ? 'ew-resize' : zone === 'body' ? 'grab' : 'text'
      if (zone === 'start' || zone === 'end') showGhost(null)
      else {
        const at = placed(grid, t, snap, free)
        showGhost(xOf(at), positionText(at, free))
      }
      return
    }
    if (!drag.moved && Math.abs(x - drag.x0) < SLOP) return
    drag.moved = true
    if (drag.kind === 'create') {
      const next = spanned(grid, drag.origin, t, snap, free, duration)
      setSel(next)
      const edge = t >= drag.origin ? next?.end : next?.start
      if (edge !== undefined) showGhost(xOf(edge), positionText(edge, free))
    } else if (drag.kind === 'edge') {
      const at = placed(grid, t, snap, free)
      const next = spanned(grid, drag.fixed, at, 'off', true, duration)
      if (next) setSel(next)
      showGhost(xOf(at), positionText(at, free))
    } else {
      const next = moved(grid, drag.from, t - drag.origin, snap, free, duration)
      setSel(next)
      showGhost(xOf(next.start), positionText(next.start, free))
    }
  }

  const onWaveUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = waveDrag.current
    endWaveDrag()
    if (!drag) return
    event.currentTarget.style.cursor = ''
    if (drag.moved) {
      onSelDone(live.current.sel)
      return
    }
    // A click, without a drag: the playhead goes there.
    const t = Math.min(duration, Math.max(0, tOf(waveX(event))))
    seekTo(player, placed(grid, t, snap, event.altKey))
  }

  const onWaveDouble = (event: React.MouseEvent<HTMLDivElement>) => {
    // A double click takes the whole bar.
    const next = barRange(grid, tOf(waveX(event)), duration)
    if (!next) return
    setSel(next)
    onSelDone(next)
  }

  const onEdgeKey = (edge: 'start' | 'end') => (event: React.KeyboardEvent) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!direction || !sel) return
    event.preventDefault()
    event.stopPropagation()
    const next = nudgeEdge(grid, sel, edge, direction, snap, event.altKey, duration)
    setSel(next)
    onSelDone(next)
  }

  /* ---- what the ruler says ---- */

  const tag = (() => {
    if (!active) return null
    if (active.kind === 'flag') {
      return { x: flagX, text: held ? `Bar 1 at ${formatClock(grid.downbeat)}` : 'Bar 1: drag it onto the first downbeat' }
    }
    const x = xOf(timeAtBar(grid, active.bar))
    return { x, text: held ? `Bar ${active.bar} · ${formatBpm(grid.bpm)} BPM` : `Bar ${active.bar}: drag it onto its beat to set the tempo` }
  })()
  const guideX = active?.kind === 'bar' ? xOf(timeAtBar(grid, active.bar)) : null

  const flagVisible = flagX >= -1 && flagX <= width + 1
  // The hint takes the side of the ruler away from the flag, and only the room on that side
  // (the flag's cloth is 22 px wide). Before the ruler is measured, it has all of it.
  const hintLeft = flagX > width / 2
  const hintRoom = width <= 0 ? Number.POSITIVE_INFINITY : hintLeft ? Math.min(width, flagX) - 16 : width - Math.max(0, flagX) - 38
  const selVisible = sel !== null && xe >= 0 && xs <= width

  return (
    <div ref={stage} className="trim-stage relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-surface" data-testid="trim-stage">
      <div
        ref={ruler}
        className="trim-ruler relative h-10 flex-none touch-none border-b border-line"
        data-testid="trim-ruler"
        onPointerDown={onRulerDown}
        onPointerMove={onRulerMove}
        onPointerUp={onRulerUp}
        onPointerCancel={onRulerUp}
        onLostPointerCapture={onRulerUp}
        onPointerLeave={() => {
          if (!rulerDrag.current) setHover(null)
        }}
      >
        <canvas ref={rulerCanvas} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
        {selVisible && sel && (
          <div className="trim-bracket" style={{ left: Math.max(0, xs), width: Math.max(1, Math.min(width, xe) - Math.max(0, xs)) }} aria-hidden="true" />
        )}
        {flagVisible || pps <= 0 ? (
          <div
            className={cn('trim-flag', active?.kind === 'flag' && 'trim-flag-active')}
            style={{ transform: `translateX(${flagX}px)` }}
            role="slider"
            tabIndex={0}
            aria-label="Bar 1"
            aria-valuemin={-60}
            aria-valuemax={Math.round(duration * 1000) / 1000}
            aria-valuenow={Math.round(grid.downbeat * 1000) / 1000}
            aria-valuetext={`Bar 1 at ${formatClock(grid.downbeat)}`}
            data-testid="bar-one-flag"
            onKeyDown={onFlagKey}
          >
            <span className="trim-flag-pole" aria-hidden="true" />
            <span className="trim-flag-cloth">1</span>
          </div>
        ) : (
          <button
            type="button"
            className={cn('trim-offscreen pressable', flagX < 0 ? 'left-1.5' : 'right-1.5')}
            aria-label="Show bar 1"
            title="Show bar 1"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={showDownbeat}
          >
            {flagX < 0 && <ChevronLeft size={11} aria-hidden="true" />}
            Bar 1
            {flagX > width && <ChevronRight size={11} aria-hidden="true" />}
          </button>
        )}
        {hint && !active && hintRoom > 140 && (
          // On the side of the ruler away from the flag, in the room there is: the two never meet.
          <div className={cn('trim-hint', hintLeft ? 'left-2' : 'right-2')} style={{ maxWidth: hintRoom }} data-testid="ruler-hint">
            {hint}
          </div>
        )}
        {tag && (
          // Changes every frame of a drag: not a live region. The flag's slider and the tempo field say it.
          <div
            className="trim-tag"
            style={{ transform: tag.x > width - 300 ? `translateX(calc(${tag.x - 6}px - 100%))` : `translateX(${tag.x + (active?.kind === 'flag' ? 22 : 6)}px)` }}
            aria-hidden="true"
          >
            {tag.text}
          </div>
        )}
        <div ref={headCap} className="trim-head-cap" aria-hidden="true" />
      </div>

      <div
        ref={wave}
        className="trim-wave relative min-h-[160px] flex-1 touch-none"
        role="application"
        tabIndex={-1}
        aria-label={`Waveform of ${label}. Drag across it to choose a part.`}
        data-testid="trim-wave"
        onPointerDown={onWaveDown}
        onPointerMove={onWaveMove}
        onPointerUp={onWaveUp}
        onPointerCancel={onWaveUp}
        onLostPointerCapture={endWaveDrag}
        onPointerLeave={() => {
          if (!waveDrag.current) showGhost(null)
        }}
        onDoubleClick={onWaveDouble}
      >
        {selVisible && <div className="trim-sel" style={{ left: xs, width: Math.max(1, xe - xs) }} aria-hidden="true" />}
        {/* Outside the part the waveform steps back; inside it, a second copy shows it whole. */}
        <Wave layers={layers.rest} t0={view.t0} t1={view.t1} gain={gain} className={cn('pointer-events-none absolute inset-0 h-full w-full', sel && 'wave-rest')} />
        {sel && (
          <Wave
            layers={layers.part}
            t0={view.t0}
            t1={view.t1}
            gain={gain}
            className="pointer-events-none absolute inset-0 h-full w-full"
            style={{ clipPath: `inset(0 ${Math.max(0, width - xe)}px 0 ${Math.max(0, xs)}px)` }}
          />
        )}
        {/* The grid over the waveform, so a beat can be seen to sit on its line or not. */}
        <canvas ref={gridCanvas} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
        {status && (
          <div className="trim-status" data-testid="trim-status">
            {status}
          </div>
        )}
        {guideX !== null && <div className="trim-guide" style={{ transform: `translateX(${guideX}px)` }} aria-hidden="true" />}
        {sel && (
          <>
            <div
              className="trim-edge"
              style={{ transform: `translateX(${xs}px)` }}
              role="slider"
              tabIndex={0}
              aria-label="Start of the selection"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration * 1000) / 1000}
              aria-valuenow={Math.round(sel.start * 1000) / 1000}
              aria-valuetext={positionText(sel.start, false)}
              data-testid="sel-start"
              data-edge="start"
              onKeyDown={onEdgeKey('start')}
            />
            <div
              className="trim-edge"
              style={{ transform: `translateX(${xe}px)` }}
              role="slider"
              tabIndex={0}
              aria-label="End of the selection"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration * 1000) / 1000}
              aria-valuenow={Math.round(sel.end * 1000) / 1000}
              aria-valuetext={positionText(sel.end, false)}
              data-testid="sel-end"
              data-edge="end"
              onKeyDown={onEdgeKey('end')}
            />
          </>
        )}
        <div ref={ghost} className="trim-ghost" style={{ opacity: 0 }} aria-hidden="true" />
        <div ref={ghostTag} className="trim-ghost-tag tabular" style={{ opacity: 0 }} aria-hidden="true" />
        <div ref={head} className="trim-head" style={{ opacity: 0 }} aria-hidden="true" />
      </div>
    </div>
  )
}

/* ---- the overview: the whole song, and the part of it on screen ------------------ */

interface OverviewProps {
  duration: number
  layers: readonly WaveLayer[]
  gain: number
  view: View
  onView: (view: View) => void
  sel: Range | null
  player: TrimPlayer
}

type OverviewDrag = { kind: 'pan'; grab: number } | { kind: 'left' } | { kind: 'right' }

export function Overview({ duration, layers, gain, view, onView, sel, player }: OverviewProps) {
  const box = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const drag = useRef<OverviewDrag | null>(null)
  const scale = width > 0 && duration > 0 ? width / duration : 0
  const vx0 = view.t0 * scale
  const vx1 = view.t1 * scale

  useFrame(() => {
    if (head.current && duration > 0) head.current.style.transform = `translateX(${(player.position / duration) * (box.current?.clientWidth ?? 0)}px)`
  })

  const xOf = (event: { clientX: number }) => event.clientX - (box.current?.getBoundingClientRect().left ?? 0)
  const tAt = (x: number) => Math.min(duration, Math.max(0, scale > 0 ? x / scale : 0))
  const zone = (x: number): OverviewDrag['kind'] | 'outside' => {
    // The edges win over the inside, so a view of the whole song can still be narrowed.
    if (Math.abs(x - vx0) <= GRAB && x <= vx1 - 2) return 'left'
    if (Math.abs(x - vx1) <= GRAB) return 'right'
    return x > vx0 && x < vx1 ? 'pan' : 'outside'
  }

  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || scale <= 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const x = xOf(event)
    const t = tAt(x)
    const where = zone(x)
    const spanNow = view.t1 - view.t0
    if (where === 'left' || where === 'right') {
      drag.current = { kind: where }
    } else if (where === 'pan') {
      drag.current = { kind: 'pan', grab: t - view.t0 }
    } else {
      // Outside the box: the view jumps there, and the drag goes on moving it.
      onView(panView(view, t - spanNow / 2 - view.t0, duration))
      drag.current = { kind: 'pan', grab: spanNow / 2 }
    }
  }

  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const x = xOf(event)
    const current = drag.current
    if (!current) {
      const where = zone(x)
      event.currentTarget.style.cursor = where === 'left' || where === 'right' ? 'ew-resize' : where === 'pan' ? 'grab' : 'pointer'
      return
    }
    const t = tAt(x)
    if (current.kind === 'pan') {
      onView(panView(view, t - current.grab - view.t0, duration))
    } else if (current.kind === 'left') {
      onView({ t0: Math.max(0, Math.min(t, view.t1 - MIN_SPAN)), t1: view.t1 })
    } else {
      onView({ t0: view.t0, t1: Math.min(duration, Math.max(t, view.t0 + MIN_SPAN)) })
    }
  }

  const onUp = () => {
    drag.current = null
  }

  return (
    <div
      ref={box}
      className="trim-overview relative h-11 min-w-0 flex-1 touch-none overflow-hidden rounded-[8px] border border-line bg-surface"
      role="group"
      aria-label="The whole song. Drag the box to move the view, drag its sides to zoom."
      data-testid="trim-overview"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <Wave layers={layers} t0={0} t1={duration} gain={gain} className="trim-overview-wave pointer-events-none absolute inset-0 h-full w-full" />
      {sel && <div className="trim-overview-sel" style={{ left: sel.start * scale, width: Math.max(1, (sel.end - sel.start) * scale) }} aria-hidden="true" />}
      <div className="trim-viewport" style={{ left: vx0, width: Math.max(4, vx1 - vx0) }} aria-hidden="true">
        <span className="trim-viewport-grip trim-viewport-grip-left" />
        <span className="trim-viewport-grip trim-viewport-grip-right" />
      </div>
      <div ref={head} className="trim-overview-head" aria-hidden="true" />
    </div>
  )
}
