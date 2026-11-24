import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserWindow, type WebPreferences, app, nativeTheme, shell } from 'electron'
import { type Theme, WINDOW_COLORS, titleBarOverlay } from './traylogic'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The theme the windows show now. `nativeTheme.themeSource` holds the user's pick, so this is
 * the pick, or the system's theme when the pick is `system`.
 */
export function currentTheme(): Theme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** What a window paints before its page does, so opening it never flashes the other theme. */
export function background(): string {
  return WINDOW_COLORS[currentTheme()].background
}

/**
 * Repaint what Electron draws itself after the theme changed. The page follows on its own
 * (`prefers-color-scheme` answers `nativeTheme`). `overlay`: the window has the title bar
 * buttons Windows draws over the page, which only the full window has, and only on Windows.
 */
export function recolor(window: BrowserWindow | null | undefined, overlay: boolean): void {
  if (!window || window.isDestroyed()) return
  const theme = currentTheme()
  window.setBackgroundColor(WINDOW_COLORS[theme].background)
  if (overlay && process.platform !== 'darwin') window.setTitleBarOverlay(titleBarOverlay(theme))
}

export function iconPath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons', name) : join(app.getAppPath(), 'resources', name)
}

/** Every window gets the same locked-down renderer: isolated, sandboxed, no Node. */
export function webPreferences(): WebPreferences {
  return {
    preload: join(here, '../preload/preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  }
}

/** Which interface a window shows: the full app, or the quick-drop window by the tray. */
export type RendererView = 'main' | 'tray'

/** Load the single-page UI. It never opens new windows and never navigates away. */
export function loadRenderer(window: BrowserWindow, view: RendererView): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  const query = view === 'tray' ? { window: 'tray' } : undefined
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (query) url.searchParams.set('window', query.window)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(here, '../renderer/index.html'), query ? { query } : undefined)
  }
}
