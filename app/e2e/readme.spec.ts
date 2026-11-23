import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type CDPSession, type Page, test } from '@playwright/test'
import { devGroupArgs } from '../electron/platform'
import { clickTray, launch, trayPage } from './helpers'

// The pictures in the README (docs/images). Run with: README_SHOTS=1 pnpm e2e -g "readme pictures"
// README_OUTPUT=<new folder> and README_MODELS=<folder> set the folders the pictures show
// (the stems panel's footer, the Models view); without them they are temp folders.
// The songs are synthetic (scripts/make_demo_song.py): the FakeEngine's stems are scaled
// copies of the input, so the demo song's own parts are written over them before a picture
// shows a waveform.
test.skip(process.env.README_SHOTS !== '1', 'set README_SHOTS=1 to capture the README pictures')

const appDir = resolve(import.meta.dirname, '..')
const engineDir = resolve(appDir, '..', 'engine')
const SONGS: [string, string, string] = ['Night Drive', 'Paper Lanterns', 'Low Tide']

function demo(mode: 'mix' | 'stems', folder: string, name: string): void {
  const script = resolve(appDir, '..', 'scripts', 'make_demo_song.py')
  const seed = String(SONGS.indexOf(name))
  execFileSync('uv', ['run', '--project', engineDir, ...devGroupArgs(process.platform), 'python', script, mode, folder, name, seed], {
    cwd: engineDir,
    stdio: 'pipe',
  })
}

const paste = (target: Page, text: string) =>
  target.evaluate((value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)

test('readme pictures', async () => {
  test.setTimeout(600_000)
  const out = resolve(appDir, '..', 'docs', 'images')
  mkdirSync(out, { recursive: true })
  const songs = mkdtempSync(join(tmpdir(), 'openstems-demo-'))
  for (const name of SONGS) demo('mix', songs, name)
  const outputDir = process.env.README_OUTPUT ?? join(mkdtempSync(join(tmpdir(), 'openstems-readme-')), 'Stems')

  const { app, page } = await launch({
    OPENSTEMS_FAKE_DELAY: '0.05',
    OPENSTEMS_OUTPUT_DIR: outputDir,
    ...(process.env.README_MODELS ? { OPENSTEMS_MODELS_DIR: process.env.README_MODELS } : {}),
  })
  const popup = await trayPage(app)
  // Twice the pixels, whatever the screen, so the pictures stay sharp on a high-density
  // display. Playwright's own screenshot puts the scale back, so the picture is taken here.
  const sessions = new Map<Page, CDPSession>()
  const sharp = async (target: Page, width: number, height: number) => {
    const session = await target.context().newCDPSession(target)
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
    sessions.set(target, session)
  }
  const shot = async (target: Page, name: string) => {
    const session = sessions.get(target)
    if (!session) throw new Error('call sharp() first')
    const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'))
  }
  const done = (target: Page, row: string) => target.locator(`[data-testid="${row}"][data-state="done"]`)
  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await sharp(page, 1280, 800)

    // Two finished songs, with the demo song's parts as their stems.
    await page.getByTestId('file-input').setInputFiles(SONGS.slice(0, 2).map((name) => join(songs, `${name}.mp3`)))
    await done(page, 'job-row').nth(1).waitFor({ timeout: 120_000 })
    for (const name of SONGS.slice(0, 2)) demo('stems', join(outputDir, name, 'full-song'), name)

    // The hero: stems on the right, a song being separated and a link being fetched.
    await page.getByTestId('file-input').setInputFiles([join(songs, `${SONGS[2]}.mp3`)])
    await paste(page, 'https://www.youtube.com/slow/Golden-Hour')
    await page.locator('[data-testid="job-row"]', { hasText: SONGS[0] }).click()
    const panel = page.getByRole('complementary', { name: 'Stems' })
    await page.getByTestId('stem-row').nth(5).waitFor()
    await page.locator('[data-testid="link-row"][data-state="downloading"]').waitFor()
    await page.locator('[data-testid="job-row"][data-state="running"]').waitFor()
    await page.waitForTimeout(1200)
    await page.mouse.move(110, 600)
    await page.waitForTimeout(200)
    await shot(page, 'app')

    await done(page, 'job-row').nth(2).waitFor({ timeout: 120_000 })
    await done(page, 'job-row').nth(3).waitFor({ timeout: 120_000 })
    demo('stems', join(outputDir, SONGS[2], 'full-song'), SONGS[2])

    // A mix: the song without its vocals, ready to drag out.
    await page.locator('[data-testid="job-row"]', { hasText: SONGS[0] }).click()
    await panel.getByText(SONGS[0]).first().waitFor()
    await panel.getByRole('button', { name: 'Mute vocals' }).click()
    await panel.getByTestId('drag-mix').filter({ hasText: 'Drag mix' }).waitFor()
    await page.mouse.move(110, 600)
    await page.waitForTimeout(400)
    await shot(page, 'mix')
    await panel.getByRole('button', { name: 'Mute vocals' }).click()

    await page.getByRole('combobox', { name: 'Recipe' }).click()
    await page.waitForTimeout(400)
    await shot(page, 'recipes')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(500)
    await shot(page, 'history')
    await page.getByRole('button', { name: 'Models' }).click()
    await page.waitForTimeout(500)
    await shot(page, 'models')

    // The quick-drop window: stems as pills, then a mix of two of them.
    await clickTray(app)
    const size = await popup.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    await sharp(popup, size.width, size.height)
    // The newest song is on top with its stems laid out.
    const row = popup.locator('[data-testid="quick-row"]').first()
    await row.getByTestId('quick-stem').nth(5).waitFor()
    await popup.mouse.move(200, 560)
    await popup.waitForTimeout(500)
    await shot(popup, 'quick-drop')
    await row.getByTestId('quick-mix').click()
    await row.getByTestId('quick-stem').filter({ hasText: 'vocals' }).click()
    await row.locator('[data-testid="mix-drag"][data-state="ready"]').waitFor()
    await popup.mouse.move(200, 560)
    await popup.waitForTimeout(400)
    await shot(popup, 'quick-drop-mix')
  } finally {
    await app.close()
  }
})
