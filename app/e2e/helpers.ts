import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, type Page, _electron as electron } from '@playwright/test'
import { type Host, dataRoot, devGroupArgs, engineEnvDir, logsDir, venvExecutable } from '../electron/platform'

const appDir = resolve(import.meta.dirname, '..')
const engineDir = resolve(appDir, '..', 'engine')

/** The suite runs on Windows and on a Mac. Where the two differ, the specs ask these. */
export const MAC = process.platform === 'darwin'
export const WINDOWS = process.platform === 'win32'

/** The key held for a shortcut: Ctrl on Windows, Cmd on a Mac. */
export const MOD = 'ControlOrMeta'

export interface Launched {
  app: ElectronApplication
  page: Page
  outputDir: string
  fixtures: string
}

export interface TrayState {
  icon: 'idle' | 'busy' | 'ready'
  tooltip: string
  hasIcon: boolean
  popupVisible: boolean
  popupBounds: { x: number; y: number; width: number; height: number } | null
  mainOpen: boolean
}

interface E2EState {
  updateInstalled: boolean
  updateOpened: string | null
  lastDrag: string[] | null
  enginePid: () => number | null
  startAtLogin: boolean
  notices: string[]
  clipboard: string
  tray: () => TrayState
  trayClick: () => void
  trayDoubleClick: () => void
}

let fixtureDir: string | null = null

/** Short MP3, FLAC and MP4 files plus one with spaces and non-ASCII characters. */
export function fixtures(): string {
  if (!fixtureDir) {
    fixtureDir = mkdtempSync(join(tmpdir(), 'openstems-fixtures-'))
    const script = resolve(appDir, '..', 'scripts', 'make_fixtures.py')
    // The same dependency groups the app starts the engine with: on a Mac a plain `uv run`
    // would try to install the NVIDIA PyTorch.
    execFileSync('uv', ['run', '--project', engineDir, ...devGroupArgs(process.platform), 'python', script, fixtureDir], {
      cwd: engineDir,
      stdio: 'pipe',
    })
  }
  return fixtureDir
}

/**
 * Launch the built app against the FakeEngine with every folder in a temp dir.
 * `args` are extra command-line arguments, such as `--tray`; with `window: 'tray'` the page
 * returned is the first window to open, without waiting for the full app's navigation.
 */
export async function launch(
  extraEnv: Record<string, string> = {},
  options: { args?: string[]; window?: 'main' | 'tray'; root?: string } = {},
): Promise<Launched> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'openstems-e2e-'))
  const outputDir = join(root, 'outputs')
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${join(root, 'user-data')}`, ...(options.args ?? [])],
    cwd: appDir,
    // Playwright answers `prefers-color-scheme` with "light" unless told not to; the app reads
    // it for its theme, which Electron's `nativeTheme` decides (`src/lib/theme.ts`).
    colorScheme: null,
    env: {
      ...(process.env as Record<string, string>),
      OPENSTEMS_E2E: '1',
      OPENSTEMS_ENGINE: 'fake',
      OPENSTEMS_FAKE_DELAY: '0.02',
      // Most tests are about something else: songs start as they are added. The tests of
      // manual start pass an empty value, which leaves the setting (off) in charge.
      OPENSTEMS_AUTO_START: '1',
      OPENSTEMS_CONFIG_DIR: join(root, 'config'),
      OPENSTEMS_MODELS_DIR: join(root, 'models'),
      OPENSTEMS_OUTPUT_DIR: outputDir,
      OPENSTEMS_CACHE_DIR: join(root, 'cache'),
      ...extraEnv,
    },
  })
  const page = await app.firstWindow()
  if (options.window !== 'tray') await page.getByRole('navigation', { name: 'Views' }).waitFor({ timeout: 90_000 })
  return { app, page, outputDir, fixtures: fixtures() }
}

const isTray = (page: Page) => new URL(page.url()).searchParams.get('window') === 'tray'

/** The quick-drop window's page. It is built hidden, ahead of the first click on the tray icon. */
export async function trayPage(app: ElectronApplication): Promise<Page> {
  const open = app.windows().find(isTray)
  return open ?? (await app.waitForEvent('window', { predicate: isTray, timeout: 30_000 }))
}

/** The full app's page, once it is open (again). */
export async function mainPage(app: ElectronApplication): Promise<Page> {
  const open = app.windows().find((page) => !isTray(page))
  return open ?? (await app.waitForEvent('window', { predicate: (page) => !isTray(page), timeout: 30_000 }))
}

/** What the tray icon shows and where the quick-drop window is. */
export function trayState(app: ElectronApplication): Promise<TrayState> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.tray())
}

/** A click on the tray icon, or on a Mac the menu bar item. */
export function clickTray(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.trayClick())
}

/** A double click on the tray icon. Windows only: a Mac's menu bar item takes single clicks. */
export function doubleClickTray(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.trayDoubleClick())
}

/**
 * What a user does to get the full window back from the icon: a double click on the tray
 * icon on Windows, a click on the Dock icon on a Mac.
 */
export function reopenFromIcon(app: ElectronApplication): Promise<void> {
  if (!MAC) return doubleClickTray(app)
  return app.evaluate(({ app }) => {
    app.emit('activate')
  })
}

/** The update stand-in was asked to install. */
export function updateInstalled(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.updateInstalled)
}

/** The page the manual update stand-in was asked to open, instead of a browser. */
export function updateOpened(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.updateOpened)
}

/** Put text on the stand-in clipboard that the Paste link button reads. */
export function setClipboard(app: ElectronApplication, text: string): Promise<void> {
  return app.evaluate((_electron, value) => {
    ;(globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.clipboard = value
  }, text)
}

/** Notices the app would have raised as notifications. */
export function notices(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.notices)
}

/**
 * A picture of the real screen around the quick-drop window, taskbar or menu bar included:
 * the window's frame, shadow and position are drawn by the system, so a page screenshot
 * cannot show them. A Mac asks for the screen recording permission first.
 */
export async function captureAroundPopup(app: ElectronApplication, path: string, margin = 40): Promise<void> {
  const bounds = (await trayState(app)).popupBounds
  if (!bounds) throw new Error('the quick-drop window does not exist')
  await app.evaluate(
    async ({ desktopCapturer, screen }, { bounds, path, margin, fromTop }) => {
      const display = screen.getDisplayMatching(bounds)
      const scale = display.scaleFactor
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
      })
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
      if (!source) throw new Error('no screen to capture')
      const left = Math.max(0, bounds.x - display.bounds.x - margin)
      // The strip the window hangs from: down to the taskbar, or up to the menu bar.
      const top = fromTop ? 0 : Math.max(0, bounds.y - display.bounds.y - margin)
      const bottom = fromTop ? Math.min(display.size.height, bounds.y - display.bounds.y + bounds.height + margin) : display.size.height
      const right = Math.min(display.size.width, bounds.x - display.bounds.x + bounds.width + margin)
      const image = source.thumbnail.crop({
        x: Math.round(left * scale),
        y: Math.round(top * scale),
        width: Math.round((right - left) * scale),
        height: Math.round((bottom - top) * scale),
      })
      const { writeFileSync } = process.mainModule!.require('node:fs') as typeof import('node:fs')
      writeFileSync(path, image.toPNG())
    },
    { bounds, path, margin, fromTop: MAC },
  )
}

/** The screen the app sees: its work area is where the quick-drop window must stay. */
export function workArea(app: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
}

/** The file paths the last drag-out handed to the main process. */
export function lastDrag(app: ElectronApplication): Promise<string[] | null> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.lastDrag)
}

export function enginePid(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.enginePid())
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/* ---- the packaged app ---------------------------------------------------------------- */

/** The unpacked build that `pnpm run pack` (Windows) or `pnpm run pack:mac` leaves in `release`. */
export function packagedExe(): string {
  return MAC
    ? resolve(appDir, 'release', 'mac-arm64', 'OpenStems.app', 'Contents', 'MacOS', 'OpenStems')
    : resolve(appDir, 'release', 'win-unpacked', 'OpenStems.exe')
}

/** Where a packaged app keeps its things for one user, and the environment that puts it there. */
export interface Profile {
  /** Variables to launch the app with. Empty for the real profile. */
  env: Record<string, string>
  /** The folder for Chromium's own data (`--user-data-dir`). */
  userData: string
  /** The Python environment that first-run setup creates. */
  engineEnv: string
  /** engine.log and selftest.json. */
  logs: string
  /** A program in that environment: `openstems`, `python`. */
  program: (name: string) => string
  /** Where electron-updater keeps a downloaded installer (Windows). */
  updaterCache: string
}

function profileFor(host: Host, env: Record<string, string>, userData: string): Profile {
  const engineEnv = engineEnvDir(host)
  return {
    env,
    userData,
    engineEnv,
    logs: logsDir(host),
    program: (name) => venvExecutable(engineEnv, name, host.platform),
    updaterCache: join(dataRoot(host), '..', 'openstems-app-updater'),
  }
}

/**
 * A fresh user account, simulated in `folder`. Windows reads LOCALAPPDATA and APPDATA. A
 * Mac has only the home folder, so HOME points there, and uv's cache and Python go with
 * it: setup downloads everything again, as on a new Mac.
 */
export function cleanProfile(folder: string): Profile {
  if (MAC) {
    mkdirSync(folder, { recursive: true })
    return profileFor({ platform: 'darwin', home: folder, env: {} }, { HOME: folder }, join(folder, 'openstems-user-data'))
  }
  const local = join(folder, 'Local')
  const roaming = join(folder, 'Roaming')
  for (const dir of [local, roaming]) mkdirSync(dir, { recursive: true })
  const env = { LOCALAPPDATA: local, APPDATA: roaming }
  return profileFor({ platform: process.platform, home: folder, env }, env, join(roaming, 'openstems-user-data'))
}

/** The profile of whoever runs the tests, untouched, for an installed copy of the app. */
export function realProfile(): Profile {
  const host: Host = { platform: process.platform, home: homedir(), env: process.env }
  return profileFor(host, {}, mkdtempSync(join(tmpdir(), 'openstems-installed-')))
}
