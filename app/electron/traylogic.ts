/**
 * The tray's decisions as plain functions, with no Electron in them: where the quick-drop
 * window sits, what the icon and its tooltip say, and the shell preferences on disk.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The screen edge the taskbar is on. */
export type Edge = 'bottom' | 'top' | 'left' | 'right'

export interface Placement extends Rect {
  edge: Edge
}

/** The quick-drop window, in device-independent pixels. */
export const POPUP_SIZE = { width: 380, height: 500 }
/** The gap Windows leaves between its own flyouts and the screen edges. */
export const POPUP_MARGIN = 12

const usable = (rect: Rect | null | undefined): rect is Rect => Boolean(rect && rect.width > 0 && rect.height > 0)
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))

/**
 * Which edge the taskbar is on. A visible taskbar takes a strip out of the work area. An
 * auto-hidden one takes nothing, so the tray icon's own position decides; with neither to go
 * on, the bottom, where Windows puts it.
 */
export function taskbarEdge(bounds: Rect, workArea: Rect, tray?: Rect | null): Edge {
  const insets: [Edge, number][] = [
    ['bottom', bounds.y + bounds.height - (workArea.y + workArea.height)],
    ['top', workArea.y - bounds.y],
    ['left', workArea.x - bounds.x],
    ['right', bounds.x + bounds.width - (workArea.x + workArea.width)],
  ]
  const [edge, inset] = insets.reduce((best, next) => (next[1] > best[1] ? next : best))
  if (inset > 0) return edge
  if (!usable(tray)) return 'bottom'
  const cx = tray.x + tray.width / 2
  const cy = tray.y + tray.height / 2
  const distances: [Edge, number][] = [
    ['bottom', bounds.y + bounds.height - cy],
    ['top', cy - bounds.y],
    ['left', cx - bounds.x],
    ['right', bounds.x + bounds.width - cx],
  ]
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0]
}

/**
 * Where the quick-drop window goes: against the taskbar, centered on the tray icon, and
 * always inside the screen. Without a usable icon position (the icon sits in the overflow
 * menu, or Windows did not say) it goes to the corner where the tray is.
 */
export function popupPlacement(
  tray: Rect | null | undefined,
  display: { bounds: Rect; workArea: Rect },
  size: { width: number; height: number } = POPUP_SIZE,
  margin: number = POPUP_MARGIN,
): Placement {
  const { bounds, workArea } = display
  const edge = taskbarEdge(bounds, workArea, tray)
  let left = workArea.x
  let top = workArea.y
  let right = workArea.x + workArea.width
  let bottom = workArea.y + workArea.height
  const icon = usable(tray) ? tray : null
  // An auto-hidden taskbar is not in the work area: stay clear of it by the icon's own edge.
  const autoHidden =
    workArea.x === bounds.x && workArea.y === bounds.y && workArea.width === bounds.width && workArea.height === bounds.height
  if (icon && autoHidden) {
    if (edge === 'bottom') bottom = Math.min(bottom, icon.y)
    if (edge === 'top') top = Math.max(top, icon.y + icon.height)
    if (edge === 'left') left = Math.max(left, icon.x + icon.width)
    if (edge === 'right') right = Math.min(right, icon.x)
  }
  const width = Math.min(size.width, right - left - 2 * margin)
  const height = Math.min(size.height, bottom - top - 2 * margin)
  const minX = left + margin
  const maxX = Math.max(minX, right - width - margin)
  const minY = top + margin
  const maxY = Math.max(minY, bottom - height - margin)

  let x: number
  let y: number
  if (edge === 'bottom' || edge === 'top') {
    x = icon ? clamp(icon.x + icon.width / 2 - width / 2, minX, maxX) : maxX
    y = edge === 'bottom' ? maxY : minY
  } else {
    x = edge === 'left' ? minX : maxX
    y = icon ? clamp(icon.y + icon.height / 2 - height / 2, minY, maxY) : maxY
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), edge }
}

/* ---- what the icon says --------------------------------------------------------- */

/** What the quick-drop window reports about the queue, for the icon and its tooltip. */
export interface TrayActivity {
  /** Jobs that are queued or running. */
  active: number
  /** The job that is running now, with its progress from 0 to 1. */
  current: { name: string; progress: number } | null
  /** The job that finished most recently in this session. */
  done: { id: string; name: string; stems: number } | null
}

export type TrayIcon = 'idle' | 'busy' | 'ready'

export interface TrayPresentation {
  icon: TrayIcon
  tooltip: string
}

const APP_NAME = 'OpenStems'
/** Windows cuts a tray tooltip at 127 characters. */
const TOOLTIP_MAX = 127

function shorten(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name
}

export function isTrayActivity(value: unknown): value is TrayActivity {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const current = v.current as Record<string, unknown> | null
  const done = v.done as Record<string, unknown> | null
  return (
    typeof v.active === 'number' &&
    (current === null || (typeof current === 'object' && typeof current.name === 'string' && typeof current.progress === 'number')) &&
    (done === null ||
      (typeof done === 'object' && typeof done.id === 'string' && typeof done.name === 'string' && typeof done.stems === 'number'))
  )
}

/**
 * The icon and tooltip for the current activity. Work in progress wins over finished work:
 * `ready` shows only once the queue is empty, and only until the result has been seen.
 */
export function trayPresentation(activity: TrayActivity | null, seenDone: string | null): TrayPresentation {
  if (activity && activity.active > 0) {
    const waiting = activity.active - (activity.current ? 1 : 0)
    const more = waiting > 0 ? ` (${waiting} waiting)` : ''
    const what = activity.current
      ? `separating ${shorten(activity.current.name, 60)}, ${Math.round(clamp(activity.current.progress, 0, 1) * 100)}%`
      : `${activity.active} queued`
    return { icon: 'busy', tooltip: `${APP_NAME}: ${what}${activity.current ? more : ''}`.slice(0, TOOLTIP_MAX) }
  }
  if (activity?.done && activity.done.id !== seenDone) {
    const { name, stems } = activity.done
    const count = `${stems} ${stems === 1 ? 'stem' : 'stems'}`
    return { icon: 'ready', tooltip: `${APP_NAME}: ${shorten(name, 70)} is ready, ${count}`.slice(0, TOOLTIP_MAX) }
  }
  return { icon: 'idle', tooltip: APP_NAME }
}

/* ---- shell preferences ------------------------------------------------------------ */

/** How the app behaves as a Windows program. Kept by the shell, not by the engine. */
export interface ShellPrefs {
  /** Closing the window leaves the app in the tray instead of quitting. */
  closeToTray: boolean
  /** The "still running" notice was shown once. */
  trayNoticeShown: boolean
  /** Look for a new version by itself, a few times a day. */
  checkForUpdates: boolean
  /** Raise a Windows notification when songs finish while the app is out of sight. */
  notifyReady: boolean
}

export const DEFAULT_PREFS: ShellPrefs = {
  closeToTray: true,
  trayNoticeShown: false,
  checkForUpdates: true,
  notifyReady: true,
}

/**
 * What the notification says when the queue has run dry out of sight: the one song by name,
 * or how many there are. `count` is how many finished since the user last looked.
 */
export function readyNotice(done: { name: string; stems: number }, count: number): { title: string; content: string } {
  if (count > 1) return { title: `${count} songs are ready`, content: 'Click to drag their stems out.' }
  const stems = `${done.stems} ${done.stems === 1 ? 'stem' : 'stems'}`
  return { title: `${shorten(done.name, 60)} is ready`, content: `${stems}. Click to drag them out.` }
}

/** Read `shell.json`. Anything missing or of the wrong type falls back to the default. */
export function parsePrefs(text: string | null | undefined): ShellPrefs {
  let stored: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text ?? '')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
  } catch {
    // No file yet, or not JSON.
  }
  const flag = (key: keyof ShellPrefs) => (typeof stored[key] === 'boolean' ? (stored[key] as boolean) : DEFAULT_PREFS[key])
  return {
    closeToTray: flag('closeToTray'),
    trayNoticeShown: flag('trayNoticeShown'),
    checkForUpdates: flag('checkForUpdates'),
    notifyReady: flag('notifyReady'),
  }
}

/** The flag a launch at login carries: start in the tray, without a window. */
export const TRAY_FLAG = '--tray'
