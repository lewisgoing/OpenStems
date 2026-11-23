/**
 * The shell's decisions as plain functions, with no Electron in them: where the quick-drop
 * window sits, what the icon and its tooltip say, the shell preferences on disk, and what
 * differs between Windows and a Mac (the window's frame, the menus, when the app quits).
 */
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'

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

/** The gap between the menu bar and the quick-drop window on a Mac. */
export const MENU_BAR_GAP = 6

/**
 * Where the quick-drop window goes on a Mac: under the menu bar, centered on the menu bar
 * item, and always inside the work area. The Dock takes its own strip out of the work area,
 * often a wider one than the menu bar, so the edge is not read from the insets here: the
 * menu bar is always at the top. A menu bar that hides itself, as over a full-screen app,
 * leaves the work area at the top of the screen; the item's lower edge then says where the
 * bar ends. Without a usable item position the window goes to the top right corner.
 */
export function menuBarPlacement(
  tray: Rect | null | undefined,
  display: { bounds: Rect; workArea: Rect },
  size: { width: number; height: number } = POPUP_SIZE,
  margin: number = POPUP_MARGIN,
  gap: number = MENU_BAR_GAP,
): Placement {
  const { workArea } = display
  const icon = usable(tray) ? tray : null
  const left = workArea.x
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height
  const top = Math.max(workArea.y, icon ? icon.y + icon.height : workArea.y)
  const width = Math.min(size.width, right - left - 2 * margin)
  const height = Math.min(size.height, bottom - top - gap - margin)
  const minX = left + margin
  const maxX = Math.max(minX, right - width - margin)
  const x = icon ? clamp(icon.x + icon.width / 2 - width / 2, minX, maxX) : maxX
  return { x: Math.round(x), y: Math.round(top + gap), width: Math.round(width), height: Math.round(height), edge: 'top' }
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

/** How the app behaves as a desktop program. Kept by the shell, not by the engine. */
export interface ShellPrefs {
  /** Closing the window leaves the app in the tray instead of quitting. Does nothing on a Mac. */
  closeToTray: boolean
  /** The "still running" notice was shown once. */
  trayNoticeShown: boolean
  /** Look for a new version by itself, a few times a day. */
  checkForUpdates: boolean
  /** Raise a notification when songs finish while the app is out of sight. */
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

/* ---- Windows and Mac ---------------------------------------------------------------- */

/** `process.platform`, passed in so the tests can ask for either system. */
export type Platform = NodeJS.Platform

const mac = (platform: Platform) => platform === 'darwin'

/** The height of the app's own title bar, in the renderer. */
export const TITLE_BAR_HEIGHT = 40
/**
 * Where the close, minimize and zoom buttons sit on a Mac. Each button's frame is 14 by 16
 * points, so 12 from the top centers them in the 40 point title bar.
 */
export const TRAFFIC_LIGHTS = { x: 14, y: 12 }
/**
 * What the title bar leaves free on its left for those buttons: they end at 68 (three
 * frames of 14, 6 apart, from 14), and 12 more keeps the first thing beside them clear.
 */
export const TRAFFIC_LIGHTS_INSET = 80

/**
 * The frame of the full window. Windows draws its buttons over the page's own title bar. A
 * Mac keeps its three buttons at the top left, with nothing drawn behind them.
 */
export function windowChrome(
  platform: Platform,
  background: string,
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  if (mac(platform)) return { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS }
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: background, symbolColor: '#8b8f98', height: TITLE_BAR_HEIGHT } }
}

/**
 * What makes the quick-drop window a small window that belongs to the icon. On Windows, a
 * tool window: no taskbar button and no entry in Alt+Tab. On a Mac, a panel: it floats over
 * every desktop and over full-screen apps, takes the keyboard without bringing the app's
 * other windows forward, and stays out of Mission Control.
 */
export function popupChrome(platform: Platform): Pick<BrowserWindowConstructorOptions, 'skipTaskbar' | 'type' | 'hiddenInMissionControl'> {
  if (mac(platform)) return { type: 'panel', hiddenInMissionControl: true }
  return { skipTaskbar: true, type: 'toolbar' }
}

/**
 * The file for each state of the icon. A Mac's menu bar takes template images: black and
 * alpha only, which macOS colors for a light or a dark bar, with an `@2x` file beside each.
 */
export function trayIconFile(icon: TrayIcon, platform: Platform): string {
  const name = icon === 'idle' ? 'tray' : `tray-${icon}`
  return mac(platform) ? `${name}Template.png` : `${name}.ico`
}

/**
 * Whether closing the full window ends the app. On Windows that is the "Keep running in the
 * tray" setting, and without a tray icon there would be no way back, so the app quits. A
 * Mac app stays open without a window: it is still in the Dock and in the menu bar, and
 * Cmd+Q quits it. The setting does nothing there.
 */
export function quitsOnWindowClose(platform: Platform, closeToTray: boolean, hasTray: boolean): boolean {
  if (mac(platform)) return false
  return !closeToTray || !hasTray
}

/**
 * Whether this launch shows no window. Windows passes `--tray` from the login item. A Mac
 * ignores a login item's arguments and says instead that it opened the app at login.
 */
export function startsHidden(platform: Platform, argv: readonly string[], openedAtLogin: boolean): boolean {
  return argv.includes(TRAY_FLAG) || (mac(platform) && openedAtLogin)
}

/** What a press on the tray icon or menu bar item asks for. Null: nothing of ours. */
export type TrayAction = 'toggle' | 'menu' | 'main' | null

/**
 * What a press on the icon does. Windows raises the menu on a right click by itself (the
 * menu is set on the icon), toggles the quick-drop window on a click and opens the full app
 * on a double click. On a Mac a menu set on the item would open on every click, so the menu
 * is raised by the app: on a right click or a Control-click. A Mac has no double click here.
 */
export function trayClickAction(platform: Platform, press: 'click' | 'right-click' | 'double-click', ctrlKey = false): TrayAction {
  if (mac(platform)) {
    if (press === 'double-click') return null
    return press === 'right-click' || ctrlKey ? 'menu' : 'toggle'
  }
  if (press === 'click') return 'toggle'
  return press === 'double-click' ? 'main' : null
}

/** The menu of the tray icon or menu bar item. A Mac writes menu items in title case. */
export function trayMenuTemplate(
  platform: Platform,
  host: { quickDrop: () => void; openMain: () => void; quit: () => void },
): MenuItemConstructorOptions[] {
  return [
    { label: mac(platform) ? 'Quick Drop' : 'Quick drop', click: host.quickDrop },
    { label: 'Show OpenStems', click: host.openMain },
    { type: 'separator' },
    { label: 'Quit OpenStems', click: host.quit },
  ]
}

/**
 * The application menu on a Mac. Without one there is no Cmd+Q, no Cmd+C, V, X or A, no
 * Cmd+W, no Cmd+M and no Hide, since on a Mac those shortcuts are menu items. Windows has
 * no menu bar in the window and gets no menu.
 */
export function macMenuTemplate(host: { name: string; settings: () => void; help: () => void }): MenuItemConstructorOptions[] {
  // The three items that carry the app's name are labelled here. Left to Electron they
  // would read `app.name`, which is the package's name ("openstems-app"), not the app's.
  return [
    {
      label: host.name,
      submenu: [
        { role: 'about', label: `About ${host.name}` },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Command+,', click: host.settings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${host.name}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${host.name}` },
      ],
    },
    { label: 'File', submenu: [{ role: 'close' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: `${host.name} on GitHub`, click: host.help }] },
  ]
}
