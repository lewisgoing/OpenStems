/**
 * Waveforms at any zoom, for the trimmer.
 *
 * A pyramid of min/max blocks over decoded audio keeps a zoomed-out draw cheap and a
 * zoomed-in one exact, down to single samples. Until a song's audio is decoded, the coarse
 * peaks the engine writes beside every file (about 4000 points a song, too few to zoom into)
 * stand in for it. Both are drawn the same way, through `WaveSource`.
 *
 * Everything is on the song's timeline: the trimmer's buffers start at the song's 0 (a stem
 * whose silence was trimmed is padded back), and peaks are placed at their file's `start`.
 */

import type { Peaks } from '@/api/client'

/** Something a waveform can be drawn from. */
export interface WaveSource {
  readonly sampleRate: number
  /** Frames on the song's timeline, from its start. */
  readonly length: number
  /** The 99th percentile of the block peaks: the level without the odd transient. */
  readonly typical: number
  /** Min and max of the frames from `i0` up to `i1`. */
  span(i0: number, i1: number): [number, number]
}

/** The block sizes of the pyramid's levels, in frames. */
const BLOCKS = [16, 64, 256, 1024, 4096]
/** Frames summed per step while a pyramid is built, between which the page can draw. */
const SLICE = 1 << 18

interface Level {
  block: number
  min: Float32Array
  max: Float32Array
}

function percentile99(values: Float32Array): number {
  if (values.length === 0) return 0
  const sorted = Float32Array.from(values).sort()
  return sorted[Math.floor(sorted.length * 0.99)] ?? 0
}

/**
 * The mono sum of one or more buffers (a stem, or a group or mix of them) as min/max levels.
 * It keeps the buffers' own samples, not a copy, for the closest zoom.
 */
export class Pyramid implements WaveSource {
  readonly sampleRate: number
  readonly length: number
  readonly typical: number
  private readonly sources: { data: Float32Array[]; scale: number }[]
  private readonly levels: Level[]

  private constructor(sources: { data: Float32Array[]; scale: number }[], sampleRate: number, length: number, levels: Level[]) {
    this.sources = sources
    this.sampleRate = sampleRate
    this.length = length
    this.levels = levels
    const middle = levels[2]
    const magnitudes = new Float32Array(middle ? middle.max.length : 0)
    if (middle) for (let i = 0; i < magnitudes.length; i++) magnitudes[i] = Math.max(middle.max[i] ?? 0, -(middle.min[i] ?? 0))
    this.typical = percentile99(magnitudes)
  }

  /** Build the pyramid of `buffers` summed, a slice at a time so the page stays responsive. */
  static async build(buffers: AudioBuffer[], yieldEvery = SLICE): Promise<Pyramid> {
    const sampleRate = buffers[0]?.sampleRate ?? 44100
    const length = Math.max(0, ...buffers.map((buffer) => buffer.length))
    // Each buffer counts as the mean of its channels, as the engine's peaks do.
    const sources = buffers.map((buffer) => {
      const data: Float32Array[] = []
      for (let c = 0; c < buffer.numberOfChannels; c++) data.push(buffer.getChannelData(c))
      return { data, scale: 1 / Math.max(1, buffer.numberOfChannels) }
    })
    const first = BLOCKS[0] ?? 16
    const count = Math.ceil(length / first)
    const min = new Float32Array(count)
    const max = new Float32Array(count)
    const sum = new Float32Array(Math.min(yieldEvery, Math.max(1, length)))
    for (let from = 0; from < length; from += sum.length) {
      const to = Math.min(length, from + sum.length)
      sum.fill(0)
      for (const { data, scale } of sources) {
        for (const channel of data) {
          const end = Math.min(to, channel.length)
          for (let i = from; i < end; i++) sum[i - from] = (sum[i - from] ?? 0) + (channel[i] ?? 0) * scale
        }
      }
      for (let i = from; i < to; i += first) {
        let lo = 0
        let hi = 0
        const stop = Math.min(to, i + first)
        for (let j = i; j < stop; j++) {
          const v = sum[j - from] ?? 0
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        min[i / first] = lo
        max[i / first] = hi
      }
      if (to < length) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const levels: Level[] = [{ block: first, min, max }]
    for (const block of BLOCKS.slice(1)) {
      const below = levels[levels.length - 1]
      if (!below) break
      const factor = block / below.block
      const n = Math.ceil(length / block)
      const lo = new Float32Array(n)
      const hi = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let a = 0
        let b = 0
        const stop = Math.min(below.min.length, (i + 1) * factor)
        for (let j = i * factor; j < stop; j++) {
          a = Math.min(a, below.min[j] ?? 0)
          b = Math.max(b, below.max[j] ?? 0)
        }
        lo[i] = a
        hi[i] = b
      }
      levels.push({ block, min: lo, max: hi })
    }
    return new Pyramid(sources, sampleRate, length, levels)
  }

  span(i0: number, i1: number): [number, number] {
    const from = Math.max(0, Math.floor(i0))
    const to = Math.min(this.length, Math.ceil(i1))
    if (to <= from) return [0, 0]
    const width = to - from
    let level: Level | null = null
    for (const candidate of this.levels) if (candidate.block * 2 <= width) level = candidate
    let lo = 0
    let hi = 0
    if (!level) {
      // Closer than a block a pixel: the samples themselves, summed as the levels are.
      for (let i = from; i < to; i++) {
        let v = 0
        for (const { data, scale } of this.sources) for (const channel of data) v += (channel[i] ?? 0) * scale
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      return [lo, hi]
    }
    const b0 = Math.floor(from / level.block)
    const b1 = Math.ceil(to / level.block)
    for (let i = b0; i < b1; i++) {
      lo = Math.min(lo, level.min[i] ?? 0)
      hi = Math.max(hi, level.max[i] ?? 0)
    }
    return [lo, hi]
  }
}

/* ---- a cache that lets go with the audio --------------------------------------------- */

/** Pyramids kept per first buffer: a few groups and mixes of one song. */
const KEEP = 6
interface Entry {
  promise: Promise<Pyramid>
  value: Pyramid | null
}
/**
 * Keyed by the first buffer, so the pyramids of a song's audio go when the player lets go
 * of it: a pyramid holds its buffers' samples.
 */
const cache = new WeakMap<AudioBuffer, Map<string, Entry>>()
const ids = new WeakMap<AudioBuffer, number>()
let nextId = 1

function keyOf(buffers: AudioBuffer[]): string {
  return buffers
    .map((buffer) => {
      let id = ids.get(buffer)
      if (!id) {
        id = nextId++
        ids.set(buffer, id)
      }
      return id
    })
    .join('+')
}

function entryOf(buffers: AudioBuffer[]): Entry | null {
  const first = buffers[0]
  return first ? (cache.get(first)?.get(keyOf(buffers)) ?? null) : null
}

/** The pyramid of these buffers summed, if it is built already. */
export function readyPyramid(buffers: AudioBuffer[]): Pyramid | null {
  return entryOf(buffers)?.value ?? null
}

/** The pyramid of these buffers summed: built once, then kept while the audio is. */
export function pyramidOf(buffers: AudioBuffer[]): Promise<Pyramid> {
  const first = buffers[0]
  if (!first) return Promise.reject(new Error('no audio to draw'))
  const known = entryOf(buffers)
  if (known) return known.promise
  const byFirst = cache.get(first) ?? new Map<string, Entry>()
  cache.set(first, byFirst)
  const key = keyOf(buffers)
  const entry: Entry = { promise: Pyramid.build(buffers), value: null }
  entry.promise.then(
    (pyramid) => {
      entry.value = pyramid
    },
    () => byFirst.delete(key),
  )
  byFirst.set(key, entry)
  while (byFirst.size > KEEP) {
    const oldest = byFirst.keys().next().value
    if (oldest === undefined) break
    byFirst.delete(oldest)
  }
  return entry.promise
}

/* ---- the engine's peaks, until the audio is decoded ---------------------------------- */

/** One file's peaks, placed on the song's timeline. */
export interface PeaksPart {
  peaks: Peaks
  /** Seconds into the song where the file begins. */
  start: number
}

/**
 * Coarse peaks of one or more files as a wave source. Several files (a group, a mix) are
 * added as their swings: louder than their true sum where they cancel, which a stand-in may be.
 */
export class PeaksWave implements WaveSource {
  readonly sampleRate: number
  readonly length: number
  readonly typical: number
  private readonly parts: PeaksPart[]

  constructor(parts: PeaksPart[], sampleRate = 44100) {
    this.parts = parts.filter((part) => part.peaks.length > 0 && part.peaks.samples_per_peak > 0)
    this.sampleRate = sampleRate
    this.length = Math.max(
      0,
      ...this.parts.map((part) => Math.ceil(part.start * sampleRate + (part.peaks.samples * sampleRate) / (part.peaks.sample_rate || sampleRate))),
    )
    let typical = 0
    for (const part of this.parts) {
      const magnitudes = new Float32Array(part.peaks.length)
      for (let i = 0; i < magnitudes.length; i++) {
        magnitudes[i] = Math.max(Math.abs(part.peaks.data[i * 2] ?? 0), Math.abs(part.peaks.data[i * 2 + 1] ?? 0))
      }
      typical += percentile99(magnitudes)
    }
    this.typical = typical
  }

  span(i0: number, i1: number): [number, number] {
    let lo = 0
    let hi = 0
    for (const { peaks, start } of this.parts) {
      // From the song's frames to this file's own, then to its blocks.
      const ratio = (peaks.sample_rate || this.sampleRate) / this.sampleRate
      const j0 = (i0 - start * this.sampleRate) * ratio
      const j1 = (i1 - start * this.sampleRate) * ratio
      const b0 = Math.max(0, Math.floor(j0 / peaks.samples_per_peak))
      const b1 = Math.min(peaks.length, Math.max(b0 + 1, Math.ceil(j1 / peaks.samples_per_peak)))
      if (j1 <= 0 || b0 >= peaks.length) continue
      let a = 0
      let b = 0
      for (let i = b0; i < b1; i++) {
        a = Math.min(a, peaks.data[i * 2] ?? 0)
        b = Math.max(b, peaks.data[i * 2 + 1] ?? 0)
      }
      lo += a
      hi += b
    }
    return [lo, hi]
  }
}

/* ---- drawing ---------------------------------------------------------------------- */

/** One vertical scale for several waveforms: the loudest fills the height, the rest keep their level. */
export function sharedGain(sources: WaveSource[]): number {
  const loudest = Math.max(0, ...sources.map((source) => source.typical))
  return loudest > 0 ? Math.min(40, 0.9 / loudest) : 1
}

/** One waveform of those drawn together: the song, a stem, or a sum of stems, in its color. */
export interface WaveLayer {
  source: WaveSource
  color: string
}

interface DrawOptions {
  t0: number
  t1: number
  gain?: number
}

/**
 * Draw `t0`..`t1` of one or more waveforms on one axis, each in its own color, one bar per
 * device pixel.
 *
 * In every column the tallest is at the back and each shorter one in front of it, so no
 * layer is ever hidden behind another: each shows as a band from its own peak to the next
 * one's, and its outline is always its own. Bands end on whole device pixels, so two colors
 * meet without a seam. One layer draws as a plain waveform.
 */
export function drawLayers(ctx: CanvasRenderingContext2D, layers: readonly WaveLayer[], x: number, y: number, w: number, h: number, o: DrawOptions): void {
  const n = layers.length
  if (n === 0 || w <= 0 || h <= 0 || o.t1 <= o.t0) return
  const gain = o.gain ?? 1
  const ratio = ctx.getTransform().a || 1
  const left = Math.round(x * ratio)
  const width = Math.round(w * ratio)
  const half = (h * ratio) / 2
  const middle = Math.round(y * ratio + half)
  // Silence still shows as a line, as thick as a CSS pixel.
  const line = Math.max(1, Math.round(ratio))
  const steps = layers.map(({ source }) => ({ start: o.t0 * source.sampleRate, per: ((o.t1 - o.t0) * source.sampleRate) / width }))
  const up = new Float64Array(n)
  const down = new Float64Array(n)
  const order = Array.from({ length: n }, (_, k) => k)
  const paths = layers.map(() => new Path2D())
  const byUp = (a: number, b: number) => (up[b] ?? 0) - (up[a] ?? 0)
  const byDown = (a: number, b: number) => (down[b] ?? 0) - (down[a] ?? 0)

  for (let px = 0; px < width; px++) {
    let any = false
    for (let k = 0; k < n; k++) {
      const { source } = layers[k] as WaveLayer
      const { start, per } = steps[k] as { start: number; per: number }
      const i0 = start + px * per
      const i1 = i0 + Math.max(1, per)
      if (i1 <= 0 || i0 >= source.length) {
        up[k] = 0
        down[k] = 0
        continue
      }
      any = true
      const [lo, hi] = source.span(i0, i1)
      up[k] = Math.round(Math.min(1, Math.max(0, hi * gain)) * half)
      down[k] = Math.round(Math.min(1, Math.max(0, -lo * gain)) * half)
    }
    if (!any) continue
    const col = left + px
    order.sort(byUp)
    const tallest = order[0] ?? 0
    for (let j = 0; j < n; j++) {
      const k = order[j] ?? 0
      const outer = up[k] ?? 0
      const inner = j + 1 < n ? (up[order[j + 1] ?? 0] ?? 0) : 0
      if (outer > inner) paths[k]?.rect(col, middle - outer, 1, outer - inner)
    }
    const peak = up[tallest] ?? 0
    order.sort(byDown)
    for (let j = 0; j < n; j++) {
      const k = order[j] ?? 0
      const outer = down[k] ?? 0
      const inner = j + 1 < n ? (down[order[j + 1] ?? 0] ?? 0) : 0
      if (outer > inner) paths[k]?.rect(col, middle + inner, 1, outer - inner)
    }
    const depth = down[order[0] ?? 0] ?? 0
    if (peak + depth < line) {
      const k = peak >= depth ? tallest : (order[0] ?? 0)
      paths[k]?.rect(col, middle - Math.floor(line / 2), 1, line)
    }
  }

  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  layers.forEach((layer, k) => {
    const path = paths[k]
    if (!path) return
    ctx.fillStyle = layer.color
    ctx.fill(path)
  })
  ctx.restore()
}
