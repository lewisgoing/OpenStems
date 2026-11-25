import { useQueries, useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { type Api, type Peaks, unwrap } from '@/api/client'
import { useEngine } from '@/api/engine'

function peaksQuery(api: Api, path: string | null | undefined) {
  return {
    queryKey: ['peaks', path],
    enabled: Boolean(path),
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => unwrap(api.GET('/v1/peaks', { params: { query: { path: path ?? '' } } })),
  }
}

/** The 99th percentile of a stem's peak magnitudes: its level without the odd transient. */
function typicalPeak(peaks: Peaks): number {
  const magnitudes = new Float32Array(peaks.length)
  for (let i = 0; i < peaks.length; i++) {
    magnitudes[i] = Math.max(Math.abs(peaks.data[i * 2] ?? 0), Math.abs(peaks.data[i * 2 + 1] ?? 0))
  }
  magnitudes.sort()
  return magnitudes[Math.floor(magnitudes.length * 0.99)] ?? 0
}

export function usePeaks(path: string | null | undefined) {
  const { api } = useEngine()
  return useQuery(peaksQuery(api, path))
}

/**
 * One scale for a whole stem set: the loudest stem fills the height and the others keep
 * their level relative to it, so a quiet stem still looks quiet.
 */
export function useSharedGain(paths: (string | null | undefined)[]): number {
  const { api } = useEngine()
  const results = useQueries({ queries: paths.map((path) => peaksQuery(api, path)) })
  const levels = results.map((r) => (r.data ? typicalPeak(r.data) : 0))
  const loudest = Math.max(0, ...levels)
  return loudest > 0 ? Math.min(40, 0.9 / loudest) : 1
}

function draw(canvas: HTMLCanvasElement, peaks: Peaks, color: string, gain: number): void {
  const ratio = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width === 0 || height === 0) return
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(ratio, ratio)
  context.clearRect(0, 0, width, height)
  context.fillStyle = color
  const middle = height / 2
  const count = peaks.length
  if (count === 0) {
    context.fillRect(0, middle - 0.5, width, 1)
    return
  }
  // One bar per pixel column: take the widest swing of the peaks that fall in it.
  for (let x = 0; x < width; x++) {
    const from = Math.floor((x / width) * count)
    const to = Math.max(from + 1, Math.floor(((x + 1) / width) * count))
    let low = 0
    let high = 0
    for (let i = from; i < to && i < count; i++) {
      low = Math.min(low, peaks.data[i * 2] ?? 0)
      high = Math.max(high, peaks.data[i * 2 + 1] ?? 0)
    }
    const top = middle - Math.min(1, high * gain) * middle
    const bottom = middle - Math.max(-1, low * gain) * middle
    context.fillRect(x, top, 1, Math.max(1, bottom - top))
  }
}

interface WaveformProps {
  peaksPath: string | null | undefined
  color: string
  /** Returns the playback position as a fraction 0..1. Read every animation frame. */
  getProgress: () => number
  onSeek: (fraction: number) => void
  dimmed?: boolean
  label: string
  /** Vertical scale. The panel sets it so the loudest stem fills the height. */
  gain?: number
}

/**
 * The waveform is drawn twice: a dim copy underneath and a bright copy on top that is
 * clipped to the played part. Moving the clip is a compositor-only change, so the
 * playhead stays smooth while the main thread is busy.
 */
export function Waveform({ peaksPath, color, getProgress, onSeek, dimmed, label, gain = 1 }: WaveformProps) {
  const { data: peaks } = usePeaks(peaksPath)
  const base = useRef<HTMLCanvasElement>(null)
  const played = useRef<HTMLCanvasElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!peaks) return
    const redraw = () => {
      if (base.current) draw(base.current, peaks, color, gain)
      if (played.current) draw(played.current, peaks, color, gain)
    }
    redraw()
    const observer = new ResizeObserver(redraw)
    if (wrap.current) observer.observe(wrap.current)
    return () => observer.disconnect()
  }, [peaks, color, gain])

  useEffect(() => {
    let frame = 0
    let last = -1
    const tick = () => {
      const fraction = Math.min(1, Math.max(0, getProgress()))
      if (fraction !== last) {
        last = fraction
        // Set styles on the elements themselves: a CSS variable on a parent would
        // recalculate every child.
        if (played.current) played.current.style.clipPath = `inset(0 ${(1 - fraction) * 100}% 0 0)`
        if (playhead.current) playhead.current.style.transform = `translateX(${fraction * (wrap.current?.clientWidth ?? 0)}px)`
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [getProgress])

  const seekFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    onSeek(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)))
  }

  return (
    <div
      ref={wrap}
      role="slider"
      aria-label={`${label} position`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(getProgress() * 100)}
      tabIndex={-1}
      className="relative h-9 min-w-0 flex-1 cursor-pointer touch-none overflow-hidden rounded-[5px]"
      style={{ opacity: dimmed ? 0.35 : 1 }}
      onPointerDown={(event) => {
        // Capture the pointer so a seek drag keeps working outside the waveform.
        event.currentTarget.setPointerCapture(event.pointerId)
        seekFromPointer(event)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event)
      }}
    >
      <canvas ref={base} className="wave-rest absolute inset-0 h-full w-full" />
      <canvas ref={played} className="absolute inset-0 h-full w-full" style={{ clipPath: 'inset(0 100% 0 0)' }} />
      <div ref={playhead} className="pointer-events-none absolute top-0 bottom-0 left-0 w-px bg-text/70" />
    </div>
  )
}
