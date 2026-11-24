import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: Parameters<typeof clsx>): string {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** Seconds as m:ss (or h:mm:ss). */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const s = String(total % 60).padStart(2, '0')
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

const STEM_COLORS: Record<string, string> = {
  vocals: '#f472b6',
  'dry vocals': '#f472b6',
  lead: '#f472b6',
  backing: '#f9a8d4',
  'lead vocals': '#f472b6',
  'backing vocals': '#f9a8d4',
  'other drums': '#d4a94a',
  instrumental: '#94a3b8',
  drums: '#fbbf24',
  kick: '#fbbf24',
  snare: '#fb923c',
  toms: '#f59e0b',
  hh: '#fde68a',
  ride: '#fcd34d',
  crash: '#fef08a',
  bass: '#60a5fa',
  guitar: '#fb923c',
  piano: '#a78bfa',
  melody: '#34d399',
  other: '#94a3b8',
  drumless: '#34d399',
  dry: '#5eead4',
  clean: '#5eead4',
}
const FALLBACK = ['#c8f04a', '#5eead4', '#f472b6', '#a78bfa', '#fbbf24', '#60a5fa', '#fb923c']

/**
 * The same colors for a light page. The bright ones above nearly vanish on white (a pale
 * yellow hi-hat, the lime), so each gets a deeper shade of its own hue, at least 3:1 against
 * the light background: a waveform or a dot is a shape, not text. No two share a shade, so
 * stems that differ on a dark page still differ on a light one.
 */
const ON_LIGHT: Record<string, string> = {
  '#f472b6': '#db2777',
  '#f9a8d4': '#e0559e',
  '#d4a94a': '#92400e',
  '#94a3b8': '#64748b',
  '#fbbf24': '#cf7006',
  '#fb923c': '#ea580c',
  '#f59e0b': '#b45309',
  '#fde68a': '#ad8200',
  '#fcd34d': '#8a8500',
  '#fef08a': '#a66f00',
  '#60a5fa': '#2563eb',
  '#a78bfa': '#7c3aed',
  '#34d399': '#059669',
  '#5eead4': '#0d9488',
  '#c8f04a': '#5f9a0a',
}

/** Every color a stem or the stem bars of the mark can take, for the tests. */
export const STEM_PALETTE: readonly string[] = Object.keys(ON_LIGHT)

/** One of the palette's colors, as it shows on the given theme. */
export function paletteColor(color: string, theme: 'light' | 'dark' = 'dark'): string {
  return theme === 'light' ? (ON_LIGHT[color] ?? color) : color
}

/** A stable color per stem name: known stems get their usual mixer color. */
export function stemColor(name: string, theme: 'light' | 'dark' = 'dark'): string {
  const known = STEM_COLORS[name.toLowerCase()]
  if (known) return paletteColor(known, theme)
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return paletteColor(FALLBACK[hash % FALLBACK.length] ?? '#c8f04a', theme)
}

/** Fill a naming template the way the engine does, for the settings preview. */
export function previewName(template: string, tokens: Record<string, string>): string {
  let out = template.replace(/\{(\w+)\}/g, (_, key: string) => tokens[key] ?? '')
  out = out.replace(/(\s*[-_]\s*){2,}/g, ' - ').replace(/^\s*[-_]\s*|\s*[-_]\s*$/g, '')
  return out.replace(/[<>:"/\\|?*]/g, '_').trim()
}
