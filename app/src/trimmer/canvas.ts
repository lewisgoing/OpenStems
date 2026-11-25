/**
 * Canvas glue for the trimmer: the theme's colors for what CSS cannot paint, a redraw at most
 * once a frame, and a loop for what moves every frame (a playhead, a clock), which is set on
 * the elements themselves rather than through React.
 */

import { type DependencyList, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Theme } from '@/lib/theme'

/** The tokens a canvas paints with, read from the stylesheet for the theme on screen. */
export interface Tokens {
  text: string
  muted: string
  faint: string
  font: string
}

function read(): Tokens {
  const style = getComputedStyle(document.documentElement)
  // The stylesheet sets every token on the root in both themes: no copy of a color is kept here.
  const get = (name: string) => style.getPropertyValue(name).trim()
  return {
    text: get('--color-text'),
    muted: get('--color-muted'),
    faint: get('--color-faint'),
    font: get('--font-sans') || 'system-ui, sans-serif',
  }
}

/** The tokens, read again whenever the theme changes. */
export function useTokens(theme: Theme): Tokens {
  // The theme is not read by `read`, but it is what changes what `read` finds.
  return useMemo(read, [theme])
}

/** A color as red, green and blue from 0 to 255: `#rgb`, `#rrggbb`, `rgb()` or `rgba()`. Null for anything else. */
export function colorChannels(color: string): [number, number, number] | null {
  const text = color.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)?.[1]
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [number, number, number]
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(text)
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null
}

/**
 * Two token colors mixed, as `color-mix` would, for a canvas that cannot read it. A color it
 * cannot read gives the first one as it is, never a wrong mix.
 */
export function mixColors(a: string, b: string, amount: number): string {
  const x = colorChannels(a)
  const y = colorChannels(b)
  if (!x || !y) return a
  const channel = (i: 0 | 1 | 2) => Math.round(x[i] * amount + y[i] * (1 - amount))
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`
}

/**
 * Draw into a canvas sized to its box at the device's pixel ratio, on the next frame after
 * `deps` change or the box is resized. Several changes in one frame draw once. A canvas with
 * no 2D context (a test's page) is left alone.
 */
export function useCanvas(
  ref: RefObject<HTMLCanvasElement | null>,
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  deps: DependencyList,
): void {
  const latest = useRef(draw)
  latest.current = draw
  const frame = useRef(0)

  const schedule = useCallback(() => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const el = ref.current
      if (!el) return
      const ratio = window.devicePixelRatio || 1
      const width = el.clientWidth
      const height = el.clientHeight
      if (!width || !height) return
      const w = Math.round(width * ratio)
      const h = Math.round(height * ratio)
      if (el.width !== w || el.height !== h) {
        el.width = w
        el.height = h
      }
      const ctx = el.getContext('2d')
      if (!ctx) return
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      latest.current(ctx, width, height)
    })
  }, [ref])

  // The caller names what the drawing depends on.
  useEffect(schedule, deps)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [ref, schedule])
}

/** Call `fn` every animation frame while mounted: for a playhead or a clock, set on the element. */
export function useFrame(fn: () => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    let frame = 0
    const tick = () => {
      ref.current()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])
}

/** The width of an element, kept current as it is resized. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}
