import { useEffect, useSyncExternalStore } from 'react'
import type { ShellStatus } from '../../electron/bridge'

/** What the user picked: `system` follows the operating system, live. Kept in `shell.json`. */
export type ThemePref = ShellStatus['theme']
/** What the page shows. */
export type Theme = 'light' | 'dark'

/**
 * The main process sets `nativeTheme.themeSource` from the pick, and Electron answers this
 * query with it in every window: the pick itself, or the system's theme under `system`. So
 * the full window and the quick-drop window follow one setting without a message of their own.
 */
const LIGHT_QUERY = '(prefers-color-scheme: light)'

const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const notify = () => {
  for (const listener of listeners) listener()
}

function reported(): Theme {
  return typeof window.matchMedia === 'function' && window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark'
}

/** The theme on screen, from the root element's `data-theme`, which the stylesheet reads. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/**
 * Show a theme. Every color changes in the same frame: with their transitions left on, the
 * buttons and the segmented controls would fade over 140 ms while the rest snapped, and the
 * page would come apart for a moment. `.theme-switching` turns transitions off, the forced
 * style pass applies the new colors under it, and the next frame turns them back on.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (root.dataset.theme === theme) return
  root.classList.add('theme-switching')
  root.dataset.theme = theme
  void getComputedStyle(root).color
  requestAnimationFrame(() => root.classList.remove('theme-switching'))
  notify()
}

/** Called once per window, before the first render: show the theme and follow its changes. */
export function startTheme(): void {
  applyTheme(reported())
  if (typeof window.matchMedia !== 'function') return
  window.matchMedia(LIGHT_QUERY).addEventListener('change', () => applyTheme(reported()))
}

/** The theme on screen, for what CSS cannot reach: the colors a canvas paints with. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme)
}

/* ---- the pick ------------------------------------------------------------------------ */

let pref: ThemePref | null = null
/** Counts picks, so a saved pick read before a click cannot undo the click when it arrives. */
let picks = 0

/**
 * The user's pick and a way to change it. Every control in a window shares it, so the switch
 * in the sidebar and the one in Settings never disagree.
 */
export function useThemePref(): [ThemePref | null, (next: ThemePref) => void] {
  const value = useSyncExternalStore(subscribe, () => pref)
  useEffect(() => {
    let live = true
    const asked = picks
    void window.openstems.shellStatus().then((status) => {
      if (live && asked === picks && status.theme !== pref) {
        pref = status.theme
        notify()
      }
    })
    return () => {
      live = false
    }
  }, [])
  return [value, setThemePref]
}

export function setThemePref(next: ThemePref): void {
  picks += 1
  pref = next
  notify()
  // A pick of light or dark shows at once, without waiting for the main process. Under
  // `system` only the main process knows the system's theme: the query's change brings it.
  if (next !== 'system') applyTheme(next)
  void window.openstems.setShell({ theme: next })
}
