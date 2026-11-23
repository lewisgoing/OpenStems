import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserWindow, type WebPreferences, app, shell } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))

export const BACKGROUND = '#0c0d0f'

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
