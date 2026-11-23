import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type { ShellStatus } from './bridge'
import { EngineProcess } from './engine'
import { log } from './log'
import { Prefs } from './prefs'
import { EngineSetup } from './setup'
import { TrayController } from './tray'
import { TRAY_FLAG, isTrayActivity } from './traylogic'
import { Updater, fakeBackend } from './updatelogic'
import { githubBackend } from './updater'
import { isVariant } from './variant'
import { BACKGROUND, iconPath, loadRenderer, webPreferences } from './windows'

const DRAGGABLE = new Set(['.wav', '.flac', '.mp3', '.mid'])

process.env.OPENSTEMS_APP_VERSION = app.getVersion()

const E2E = process.env.OPENSTEMS_E2E === '1'
const engine = new EngineProcess()
const setup = new EngineSetup()
const prefs = new Prefs()
let mainWindow: BrowserWindow | null = null
let quitting = false

const tray = new TrayController({
  openMain: () => showMain(),
  quit: () => app.quit(),
  mainFocused: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()),
  notifyReady: () => prefs.value.notifyReady,
  recordNotice: E2E ? (title) => e2eState.notices.push(title) : undefined,
})

// Self-update needs an installed app. Tests get a stand-in that never touches the network.
const E2E_UPDATE = E2E ? process.env.OPENSTEMS_E2E_UPDATE : undefined
const updater = new Updater({
  current: app.getVersion(),
  backend: E2E_UPDATE
    ? fakeBackend(E2E_UPDATE, () => (e2eState.updateInstalled = true))
    : app.isPackaged && !E2E
      ? githubBackend()
      : null,
  // The installer replaces the app's files: nothing of ours may still be running.
  beforeInstall: async () => {
    quitting = true
    tray.destroy()
    await engine.stop()
  },
  log,
})

const e2eState = {
  /** The update stand-in was asked to install. */
  updateInstalled: false,
  lastDrag: null as string[] | null,
  enginePid: () => engine.enginePid,
  /** Stands in for the Windows login item, so tests never touch the registry. */
  startAtLogin: false,
  notices: [] as string[],
  /** Stands in for the system clipboard, which tests must not read or change. */
  clipboard: '',
  tray: () => ({
    icon: tray.presentation.icon,
    tooltip: tray.presentation.tooltip,
    hasIcon: tray.tray !== null,
    popupVisible: tray.visible,
    popupBounds: tray.popup && !tray.popup.isDestroyed() ? tray.popup.getBounds() : null,
    mainOpen: mainWindow !== null,
  }),
  /** A click on the tray icon: through the real icon when there is one. */
  trayClick: () => {
    if (tray.tray) tray.tray.emit('click')
    else tray.toggle()
  },
  trayDoubleClick: () => {
    if (tray.tray) tray.tray.emit('double-click')
    else showMain()
  },
}
if (E2E) (globalThis as Record<string, unknown>).__openstemsE2E = e2eState

/** Status changes go to every window: the full app and the quick-drop window. */
function send(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: BACKGROUND,
    title: 'OpenStems',
    icon: iconPath('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: BACKGROUND, symbolColor: '#8b8f98', height: 40 },
    webPreferences: webPreferences(),
  })
  mainWindow = window
  window.once('ready-to-show', () => {
    window.show()
    tray.prewarm()
  })
  window.on('focus', () => tray.markSeen())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    if (quitting) return
    if (!prefs.value.closeToTray || !tray.tray) {
      app.quit()
    } else if (!prefs.value.trayNoticeShown) {
      prefs.update({ trayNoticeShown: true })
      tray.notifyStillRunning()
    }
  })
  loadRenderer(window, 'main')
}

/** Bring the full app to the front, opening its window again if it was closed to the tray. */
function showMain(): void {
  tray.hide()
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/* ---- start with Windows ------------------------------------------------------------ */

// Only an installed app registers itself: in development the entry would point at Electron.
const canStartAtLogin = app.isPackaged || E2E

function startsAtLogin(): boolean {
  if (E2E) return e2eState.startAtLogin
  return app.isPackaged && app.getLoginItemSettings({ args: [TRAY_FLAG] }).openAtLogin
}

function setStartAtLogin(on: boolean): void {
  if (E2E) e2eState.startAtLogin = on
  else if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: [TRAY_FLAG] })
}

function shellStatus(): ShellStatus {
  return {
    closeToTray: prefs.value.closeToTray,
    checkForUpdates: prefs.value.checkForUpdates,
    notifyReady: prefs.value.notifyReady,
    startAtLogin: startsAtLogin(),
    canStartAtLogin,
  }
}

function registerIpc(): void {
  ipcMain.handle('engine:get', () => engine.status)
  ipcMain.handle('engine:restart', () => engine.restart())
  ipcMain.handle('setup:get', () => setup.status)
  ipcMain.handle('setup:detect', async () => {
    await setup.detect()
    return setup.status
  })
  ipcMain.handle('setup:run', async (_event, variant?: unknown) => {
    await setup.runSetup(isVariant(variant) ? variant : undefined)
    if (setup.status.state === 'ready') engine.start()
  })
  // Rebuild the environment with the other PyTorch build. The engine holds files in it open.
  ipcMain.handle('setup:switch', async (_event, variant: unknown) => {
    if (!isVariant(variant) || !setup.status.managed || setup.status.state === 'running') return
    log(`switching the engine build to ${variant}`)
    await engine.stop()
    await setup.runSetup(variant)
    if (setup.status.state === 'ready') engine.start()
  })

  // Native drag-out: hand real files to the DAW or Explorer.
  ipcMain.on('drag:start', (event, paths: unknown) => {
    if (!Array.isArray(paths)) return
    const files = paths.filter(
      (p): p is string =>
        typeof p === 'string' && DRAGGABLE.has(extname(p).toLowerCase()) && existsSync(p) && statSync(p).isFile(),
    )
    const first = files[0]
    if (first === undefined) return
    if (E2E) {
      // A native drag blocks until the mouse is released, so tests record it instead.
      e2eState.lastDrag = files
      return
    }
    const icon = nativeImage.createFromPath(iconPath(files.length > 1 ? 'drag-many.png' : 'drag-one.png'))
    event.sender.startDrag({ file: first, files, icon })
  })

  // The Paste link button: the text on the clipboard, which a sandboxed page cannot read
  // without a prompt.
  ipcMain.handle('clipboard:read', async () => {
    const text = E2E ? e2eState.clipboard : await clipboard.readText()
    return String(text).slice(0, 4096)
  })

  ipcMain.handle('shell:reveal', (_event, path: string) => {
    if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path)
  })
  ipcMain.handle('shell:open-folder', async (_event, path: string) => {
    if (typeof path === 'string' && existsSync(path)) await shell.openPath(path)
  })
  ipcMain.handle('dialog:pick-folder', async (event, defaultPath?: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) return null
    const result = await dialog.showOpenDialog(owner, {
      defaultPath: typeof defaultPath === 'string' && existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('dialog:pick-file', async (event, options: { title: string; extensions: string[] }) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) return null
    const result = await dialog.showOpenDialog(owner, {
      title: options.title,
      filters: [{ name: options.title, extensions: options.extensions }],
      properties: ['openFile'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // The tray and its quick-drop window.
  ipcMain.handle('main:show', () => showMain())
  ipcMain.on('popup:hide', (_event, viaKeyboard: unknown) => tray.hide(viaKeyboard === true))
  ipcMain.on('tray:activity', (_event, activity: unknown) => {
    if (isTrayActivity(activity)) tray.setActivity(activity)
  })
  ipcMain.handle('shell:get', () => shellStatus())
  ipcMain.handle('shell:set', (_event, patch: unknown) => {
    const changes = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
    if (typeof changes.closeToTray === 'boolean') prefs.update({ closeToTray: changes.closeToTray })
    if (typeof changes.checkForUpdates === 'boolean') prefs.update({ checkForUpdates: changes.checkForUpdates })
    if (typeof changes.notifyReady === 'boolean') prefs.update({ notifyReady: changes.notifyReady })
    if (typeof changes.startAtLogin === 'boolean' && canStartAtLogin) setStartAtLogin(changes.startAtLogin)
    return shellStatus()
  })

  // Self-update.
  ipcMain.handle('update:get', () => updater.status)
  ipcMain.handle('update:check', () => updater.check(true))
  ipcMain.handle('update:download', () => updater.download())
  ipcMain.handle('update:install', async (_event, force: unknown) => {
    const activeJobs = tray.activeJobs
    // A restart stops the queue: the user is asked first, in the window.
    if (updater.status.state !== 'ready' || (activeJobs > 0 && force !== true)) return { started: false, activeJobs }
    void updater.install()
    return { started: true, activeJobs }
  })
}

// One app instance: a second launch brings up the first one's window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // A second launch at login has nothing to show: the app is already in the tray.
    if (!argv.includes(TRAY_FLAG)) showMain()
  })

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    registerIpc()
    const inTray = process.argv.includes(TRAY_FLAG)
    log(`app ${app.getVersion()} started (packaged: ${app.isPackaged}${inTray ? ', in the tray' : ''})`)
    engine.onStatus((status) => {
      log(`engine ${status.state}${status.state === 'failed' ? `: ${status.error}` : ''}`)
      send('engine:status', status)
    })
    let setupState = setup.status.state
    setup.onStatus((status) => {
      if (status.state !== setupState) {
        setupState = status.state
        log(`setup ${status.state}${status.error ? `: ${status.error}` : ''}`)
        if (status.state !== 'running') for (const line of status.log.slice(-40)) log(`setup | ${line}`)
      }
      send('setup:status', status)
    })
    updater.onStatus((status) => send('update:status', status))
    updater.schedule(() => prefs.value.checkForUpdates)
    tray.create()
    // Started in the tray, the app shows no window, unless first-run setup needs the user.
    const refresh = setup.canRefresh() // after an app update: seconds, and nothing to click
    if (inTray && tray.tray && (setup.status.state === 'ready' || refresh)) tray.prewarm()
    else createWindow()
    if (setup.status.state === 'ready') {
      engine.start()
    } else if (refresh) {
      void setup.refresh().then(() => {
        if (setup.status.state === 'ready') {
          engine.start()
        } else {
          // The quick way failed: offer the full setup, which needs the window.
          void setup.detect()
          showMain()
        }
      })
    } else {
      void setup.detect() // the setup screen shows what was found
    }
  })

  // The quick-drop window exists while the app runs, so this fires only without a tray.
  app.on('window-all-closed', () => {
    if (!prefs.value.closeToTray || !tray.tray) app.quit()
  })

  // On quit, stop the engine first so no process is left behind.
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    tray.destroy()
    void engine.stop().finally(() => app.exit(0))
  })
}
