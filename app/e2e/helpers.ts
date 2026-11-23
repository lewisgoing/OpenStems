import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ElectronApplication, type Page, _electron as electron } from '@playwright/test'

const appDir = resolve(import.meta.dirname, '..')
const engineDir = resolve(appDir, '..', 'engine')

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
  lastDrag: string[] | null
  enginePid: () => number | null
  startAtLogin: boolean
  notices: string[]
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
    execFileSync('uv', ['run', '--project', engineDir, 'python', script, fixtureDir], {
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

/** A click on the tray icon. */
export function clickTray(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.trayClick())
}

export function doubleClickTray(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.trayDoubleClick())
}

/** Notices the app would have raised as Windows notifications. */
export function notices(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __openstemsE2E: E2EState }).__openstemsE2E.notices)
}

/**
 * A picture of the real screen around the quick-drop window, taskbar included: the window's
 * frame, shadow and position are drawn by Windows, so a page screenshot cannot show them.
 */
export async function captureAroundPopup(app: ElectronApplication, path: string, margin = 40): Promise<void> {
  const bounds = (await trayState(app)).popupBounds
  if (!bounds) throw new Error('the quick-drop window does not exist')
  await app.evaluate(
    async ({ desktopCapturer, screen }, { bounds, path, margin }) => {
      const display = screen.getDisplayMatching(bounds)
      const scale = display.scaleFactor
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
      })
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
      if (!source) throw new Error('no screen to capture')
      const left = Math.max(0, bounds.x - display.bounds.x - margin)
      const top = Math.max(0, bounds.y - display.bounds.y - margin)
      const right = Math.min(display.size.width, bounds.x - display.bounds.x + bounds.width + margin)
      const image = source.thumbnail.crop({
        x: Math.round(left * scale),
        y: Math.round(top * scale),
        width: Math.round((right - left) * scale),
        height: Math.round((display.size.height - top) * scale),
      })
      const { writeFileSync } = process.mainModule!.require('node:fs') as typeof import('node:fs')
      writeFileSync(path, image.toPNG())
    },
    { bounds, path, margin },
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
