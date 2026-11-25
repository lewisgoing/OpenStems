/**
 * The words and keys that differ between Windows and a Mac, in one place. Everything reads
 * the platform when it is called, so a test can change `window.openstems.info.platform`.
 */

export function isMac(): boolean {
  return window.openstems.info.platform === 'darwin'
}

export interface PlatformWords {
  /** Where files are shown: "Reveal in Explorer". */
  fileManager: string
  /** Where the small icon lives, mid-sentence: "Starts in the tray". */
  tray: string
  /** The same as a heading. */
  trayTitle: string
  /** The switch that starts the app with the system. */
  loginItem: string
  /** The machine itself: "fits this PC". */
  computer: string
  /** Where first-run setup puts the engine. */
  profile: string
  /** What holds folders, for free space: "120 GB free on this drive". */
  drive: string
}

const WINDOWS: PlatformWords = {
  fileManager: 'Explorer',
  tray: 'tray',
  trayTitle: 'Tray',
  loginItem: 'Start with Windows',
  computer: 'PC',
  profile: 'your user profile',
  drive: 'drive',
}

const MAC: PlatformWords = {
  fileManager: 'Finder',
  tray: 'menu bar',
  trayTitle: 'Menu bar',
  loginItem: 'Open at login',
  computer: 'Mac',
  profile: 'your Library folder',
  drive: 'disk',
}

export function words(): PlatformWords {
  return isMac() ? MAC : WINDOWS
}

/** A shortcut as it is written on this system: "Ctrl+V" on Windows, "⌘V" on a Mac. */
export function shortcut(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl+${key}`
}

/** A click with the modifier held: "Ctrl+click" on Windows, "⌘-click" on a Mac. */
export function modClick(): string {
  return isMac() ? '⌘-click' : 'Ctrl+click'
}

/** The shortcut key by itself, to be held: "hold Ctrl and scroll", "hold ⌘ and scroll". */
export function modName(): string {
  return isMac() ? '⌘' : 'Ctrl'
}

/**
 * The key held to place something off the grid, freely: Alt on Windows, Option on a Mac.
 * Both arrive as `altKey`.
 */
export function freeKey(): string {
  return isMac() ? 'Option' : 'Alt'
}

/**
 * The key that goes to the start: Home, which a Mac's laptop keyboard has only as Fn with the
 * left arrow. Both arrive as "Home".
 */
export function homeKey(): string {
  return isMac() ? 'Home, or Fn+←' : 'Home'
}

/**
 * Whether the system's shortcut key is held: Ctrl on Windows, Command on a Mac. Control is
 * not taken on a Mac, where Control+1 switches desktops and a Control-click is a right click.
 */
export function modKey(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.ctrlKey
}
