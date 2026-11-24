// The trimmer's waveform with several stems layered, each in its own color (drawLayers).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type WaveLayer, type WaveSource, drawLayers } from '@/audio/pyramid'

type Rect = [x: number, y: number, w: number, h: number]

/** A path that keeps the rectangles added to it. */
class RecordedPath {
  rects: Rect[] = []
  rect(x: number, y: number, w: number, h: number) {
    this.rects.push([x, y, w, h])
  }
}

/** A wave at `level` (or a level per frame) over `length` frames, at 1000 frames a second. */
function wave(level: number | ((frame: number) => number), length = 1000): WaveSource {
  const at = typeof level === 'number' ? () => level : level
  return { sampleRate: 1000, length, typical: 1, span: (i0) => [-at(i0), at(i0)] }
}

/** Draw one second of `layers` into a `w` by `h` box; what was filled in each color. */
function draw(layers: WaveLayer[], { w = 10, h = 100, ratio = 1 } = {}): Map<string, Rect[]> {
  vi.stubGlobal('Path2D', RecordedPath)
  const fills = new Map<string, Rect[]>()
  const ctx = {
    fillStyle: '',
    getTransform: () => ({ a: ratio }),
    save() {},
    restore() {},
    setTransform() {},
    fill(path: RecordedPath) {
      fills.set(this.fillStyle, [...(fills.get(this.fillStyle) ?? []), ...path.rects])
    },
  }
  drawLayers(ctx as unknown as CanvasRenderingContext2D, layers, 0, 0, w, h, { t0: 0, t1: 1 })
  return fills
}

/** The rows a color covers in column `x`. */
function rows(rects: Rect[] | undefined, x: number): Set<number> {
  const out = new Set<number>()
  for (const [rx, y, , h] of rects ?? []) if (rx === x) for (let r = y; r < y + h; r++) out.add(r)
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('drawLayers', () => {
  it('draws one layer as a plain waveform around the middle', () => {
    const fills = draw([{ source: wave(0.5), color: 'red' }])
    expect([...fills.keys()]).toEqual(['red'])
    for (let x = 0; x < 10; x++) {
      const covered = [...rows(fills.get('red'), x)].sort((a, b) => a - b)
      expect(covered[0]).toBe(25)
      expect(covered.at(-1)).toBe(74)
      expect(covered).toHaveLength(50)
    }
  })

  it('puts the shorter layer in front, so each shows from its own peak to the next one', () => {
    const fills = draw([
      { source: wave(0.8), color: 'tall' },
      { source: wave(0.4), color: 'short' },
    ])
    const tall = rows(fills.get('tall'), 3)
    const short = rows(fills.get('short'), 3)
    // No row is painted twice, and together they reach the tall one's peak on both sides.
    expect([...tall].filter((r) => short.has(r))).toEqual([])
    expect(Math.min(...tall)).toBe(10)
    expect(Math.max(...tall)).toBe(89)
    expect(Math.min(...short)).toBe(30)
    expect(Math.max(...short)).toBe(69)
  })

  it('orders the layers in every column, so a layer louder only for a moment is never hidden', () => {
    // One is loud in the first half of the second and quiet in the second; the other the reverse.
    const first = wave((frame) => (frame < 500 ? 0.8 : 0.2))
    const second = wave((frame) => (frame < 500 ? 0.2 : 0.8))
    const fills = draw([
      { source: first, color: 'first' },
      { source: second, color: 'second' },
    ])
    for (let x = 0; x < 10; x++) {
      expect(rows(fills.get('first'), x).size).toBeGreaterThan(0)
      expect(rows(fills.get('second'), x).size).toBeGreaterThan(0)
    }
    // The outline is the louder one's: the first's at the start, the second's at the end.
    expect(rows(fills.get('first'), 0).has(10)).toBe(true)
    expect(rows(fills.get('second'), 9).has(10)).toBe(true)
  })

  it('shows silence as a line, and draws nothing past the end of the audio', () => {
    const fills = draw([{ source: wave(0, 500), color: 'quiet' }])
    expect(rows(fills.get('quiet'), 2).size).toBe(1)
    expect(rows(fills.get('quiet'), 8).size).toBe(0)
  })

  it('draws on whole device pixels at twice the density', () => {
    const fills = draw([{ source: wave(0.333), color: 'fine' }], { w: 10, h: 101, ratio: 2 })
    const rects = fills.get('fine') ?? []
    // Twenty columns for ten CSS pixels, every edge on a whole pixel.
    expect(new Set(rects.map(([x]) => x)).size).toBe(20)
    for (const rect of rects) for (const value of rect) expect(Number.isInteger(value)).toBe(true)
  })
})
