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

/** A stable color per stem name: known stems get their usual mixer color. */
export function stemColor(name: string): string {
  const known = STEM_COLORS[name.toLowerCase()]
  if (known) return known
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return FALLBACK[hash % FALLBACK.length] ?? '#c8f04a'
}

/** Fill a naming template the way the engine does, for the settings preview. */
export function previewName(template: string, tokens: Record<string, string>): string {
  let out = template.replace(/\{(\w+)\}/g, (_, key: string) => tokens[key] ?? '')
  out = out.replace(/(\s*[-_]\s*){2,}/g, ' - ').replace(/^\s*[-_]\s*|\s*[-_]\s*$/g, '')
  return out.replace(/[<>:"/\\|?*]/g, '_').trim()
}
