import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@playwright/test'
import { MAC, captureAroundPopup, clickTray, launch, trayPage } from './helpers'

// Design review screenshots. Run with: SHOTS=1 pnpm e2e -g screenshots
// The file names are the same on Windows and on a Mac: give each system its own SHOTS_DIR.
test.skip(process.env.SHOTS !== '1', 'set SHOTS=1 to capture screenshots')

/** The main views, dark (the default) or, picked with the sidebar's switch, light. */
async function mainViews(theme: 'dark' | 'light') {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page, fixtures } = await launch({ OPENSTEMS_FAKE_DELAY: '0.15' })
  const prefix = theme === 'light' ? 'light-' : ''
  const shot = (name: string) => page.screenshot({ path: join(out, `${prefix}${name}.png`) })
  try {
    if (theme === 'light') {
      await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' }).click()
      await page.waitForTimeout(300)
    }
    await shot('1-empty')
    await page.getByTestId('file-input').setInputFiles(
      ['First Song.mp3', 'Second Song.flac', 'Video Clip.mp4'].map((n) => join(fixtures, n)),
    )
    await page.locator('[data-testid="job-row"][data-state="running"]').first().waitFor()
    await page.waitForTimeout(600)
    await shot('2-queue-running')
    await page.locator('[data-testid="job-row"][data-state="done"]').nth(2).waitFor()
    await page.locator('[data-testid="job-row"][data-state="done"]').first().click()
    await page.getByTestId('stem-row').nth(5).waitFor()
    await page.waitForTimeout(700)
    await shot('3-stems')
    await page.getByRole('combobox', { name: 'Recipe' }).click()
    await page.waitForTimeout(400)
    await shot('4-recipes')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(500)
    await shot('5-history')
    await page.getByRole('button', { name: 'Models' }).click()
    await page.waitForTimeout(500)
    await shot('6-models')
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.waitForTimeout(500)
    await shot('7-settings')
    if (theme === 'light') {
      // The quick-drop window follows the pick, with the stems of the last song.
      await clickTray(app)
      const popup = await trayPage(app)
      await popup.waitForTimeout(600)
      await popup.screenshot({ path: join(out, `${prefix}tray.png`) })
    }
  } finally {
    await app.close()
  }
}

test('screenshots', async () => {
  await mainViews('dark')
})

test('screenshots in light', async () => {
  await mainViews('light')
})

test('screenshots of the quick-drop window', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, fixtures } = await launch({ OPENSTEMS_FAKE_DELAY: '0.25' })
  const page = await trayPage(app)
  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) })
  try {
    await clickTray(app)
    await page.getByRole('heading', { name: 'Drop a song here' }).waitFor()
    await page.waitForTimeout(400)
    await shot('tray-1-empty')

    // A file dragged over the window.
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.items.add(new File([''], 'song.mp3'))
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data }))
    })
    await page.waitForTimeout(400)
    await shot('tray-2-drag-over')
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.items.add(new File([''], 'song.mp3'))
      window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: data }))
    })

    await page.getByTestId('file-input').setInputFiles(
      ['First Song.mp3', 'Second Song.flac', 'Video Clip.mp4'].map((n) => join(fixtures, n)),
    )
    await page.locator('[data-testid="quick-row"][data-state="running"]').first().waitFor()
    await page.waitForTimeout(500)
    await shot('tray-3-running')
    await page.locator('[data-testid="quick-row"][data-state="done"]').nth(2).waitFor()
    await page.waitForTimeout(700)
    await shot('tray-4-done')
    // The real screen: frame, shadow and where the window sits by the taskbar or under the
    // menu bar. A Mac lets an app see the screen only with the screen recording permission:
    // without it this one picture is left out and the rest go on.
    await captureAroundPopup(app, join(out, 'tray-on-screen.png')).catch((error: unknown) => {
      if (!MAC) throw error
      console.log(`tray-on-screen.png was not captured: ${String(error)}`)
    })
    await page.locator('[data-testid="quick-row"][data-state="done"]').nth(1).hover()
    await page.waitForTimeout(300)
    await shot('tray-5-hover')
    await page.getByTestId('quick-stem').nth(2).click()
    await page.locator('[data-testid="quick-stem"][data-audition="playing"]').waitFor()
    await page.mouse.move(200, 470)
    await page.waitForTimeout(250)
    await shot('tray-8-listening')
    await page.getByTestId('quick-stem').nth(2).click()
    await page.getByRole('combobox', { name: 'Recipe' }).click()
    await page.waitForTimeout(400)
    await shot('tray-6-recipes')
    await page.getByRole('option', { name: /Drum kit/ }).click()
    await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])
    await page.locator('[data-testid="quick-row"][data-state="done"]').nth(3).waitFor()
    await page.waitForTimeout(700)
    await shot('tray-7-drum-kit')
  } finally {
    await app.close()
  }
})

test('screenshots of the update offer', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page } = await launch({ OPENSTEMS_E2E_UPDATE: '0.3.0' })
  const popup = await trayPage(app)
  try {
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Check for updates' }).click()
    await page.getByRole('button', { name: 'Update to 0.3.0' }).waitFor()
    await page.getByText('Version 0.3.0 is available.').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'update-1-available.png') })
    await clickTray(app)
    await popup.getByRole('button', { name: 'Update', exact: true }).waitFor()
    await popup.waitForTimeout(300)
    await popup.screenshot({ path: join(out, 'update-2-quick-drop.png') })
    await page.getByRole('button', { name: 'Update to 0.3.0' }).click()
    await page.getByRole('button', { name: 'Restart to update' }).first().waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(out, 'update-3-ready.png') })
  } finally {
    await app.close()
  }
})

test('screenshots of manual start', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page, fixtures } = await launch({ OPENSTEMS_AUTO_START: '', OPENSTEMS_FAKE_DELAY: '0.3' })
  const popup = await trayPage(app)
  try {
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.getByTestId('file-input').setInputFiles(
      ['First Song.mp3', 'Second Song.flac', 'Video Clip.mp4'].map((n) => join(fixtures, n)),
    )
    await page.getByRole('button', { name: 'Start 3 songs' }).waitFor()
    await page.getByTestId('job-row').nth(1).hover()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'manual-1-waiting.png') })
    await clickTray(app)
    await popup.getByRole('button', { name: 'Start 3 songs' }).waitFor()
    await popup.waitForTimeout(300)
    await popup.screenshot({ path: join(out, 'manual-2-quick-drop.png') })
    await page.getByTestId('job-row').nth(1).getByRole('button', { name: 'Start this one' }).click()
    await page.locator('[data-testid="job-row"][data-state="running"]').waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(out, 'manual-3-one-started.png') })
  } finally {
    await app.close()
  }
})

test('screenshots of links and mixes', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page, fixtures } = await launch({ OPENSTEMS_FAKE_DELAY: '0.05' })
  const popup = await trayPage(app)
  const paste = (target: typeof page, text: string) =>
    target.evaluate((value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)
  try {
    // The full window: an empty queue, then a fetch under way beside a job and a failed one.
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'links-1-empty.png') })
    await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])
    await page.locator('[data-testid="job-row"][data-state="done"]').waitFor()
    await paste(page, 'https://example.com/fail/nothing-here')
    await paste(page, 'https://www.youtube.com/slow/Night-Drive')
    await page.locator('[data-testid="link-row"][data-state="downloading"]').waitFor()
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(out, 'links-2-fetching.png') })
    await page.locator('[data-testid="link-row"][data-state="failed"]').hover()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(out, 'links-3-failed-hover.png') })

    // The quick-drop window with the same queue.
    await clickTray(app)
    await popup.locator('[data-testid="link-row"]').first().waitFor()
    await popup.waitForTimeout(400)
    await popup.screenshot({ path: join(out, 'links-4-tray.png') })
    await popup.locator('[data-testid="quick-row"][data-state="done"]').nth(1).waitFor({ timeout: 30_000 })
    const done = popup.locator('[data-testid="quick-row"][data-state="done"]').first()
    await popup.waitForTimeout(600)
    await popup.screenshot({ path: join(out, 'mix-1-before.png') })
    await done.getByTestId('quick-mix').click()
    await popup.mouse.move(200, 480)
    await popup.waitForTimeout(350)
    await popup.screenshot({ path: join(out, 'mix-2-all-in.png') })
    await done.getByTestId('quick-stem').filter({ hasText: 'vocals' }).click()
    await popup.mouse.move(200, 480)
    await popup.waitForTimeout(120)
    await popup.screenshot({ path: join(out, 'mix-3-preparing.png') })
    await done.locator('[data-testid="mix-drag"][data-state="ready"]').waitFor()
    await popup.screenshot({ path: join(out, 'mix-4-no-vocals.png') })
    await done.getByRole('button', { name: 'Play the mix' }).click()
    await done.getByRole('button', { name: 'Pause the mix' }).waitFor()
    await popup.mouse.move(200, 480)
    await popup.waitForTimeout(300)
    await popup.screenshot({ path: join(out, 'mix-5-playing.png') })
    for (const name of ['guitar', 'piano', 'other']) await done.getByTestId('quick-stem').filter({ hasText: name }).click()
    await done.locator('[data-testid="mix-drag"][data-state="ready"]').waitFor()
    await popup.mouse.move(200, 480)
    await popup.waitForTimeout(200)
    await popup.screenshot({ path: join(out, 'mix-6-two-stems.png') })

    // The full window's panel: mute a stem, and the mix can leave.
    await page.locator('[data-testid="job-row"][data-state="done"]').first().click()
    const panel = page.getByRole('complementary', { name: 'Stems' })
    await panel.getByRole('button', { name: 'Mute vocals' }).click()
    await panel.getByTestId('drag-mix').filter({ hasText: 'Drag mix' }).waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'mix-7-panel.png') })
  } finally {
    await app.close()
  }
})

test('screenshots of a machine with little memory', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  // The machine acts as 8 GB, and the largest model of the default recipe falls back to the CPU.
  const { app, page, fixtures } = await launch({ OPENSTEMS_MEMORY_GB: '8', OPENSTEMS_FAKE_OOM: 'bs-roformer-sw', OPENSTEMS_FAKE_DELAY: '0.05' })
  const popup = await trayPage(app)
  try {
    await page.getByTestId('file-input').setInputFiles(['First Song.mp3', 'Second Song.flac'].map((n) => join(fixtures, n)))
    await page.locator('[data-testid="job-row"][data-state="done"]').nth(1).waitFor()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, 'memory-1-queue.png') })
    await page.locator('[data-testid="job-row"][data-state="done"]').first().click()
    await page.getByTestId('stem-row').nth(5).waitFor()
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(out, 'memory-2-stems.png') })
    await page.getByRole('combobox', { name: 'Recipe' }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'memory-3-recipes.png') })
    await page.getByRole('option', { name: /best vocals/i }).first().click()
    await page.getByTestId('recipe-fit').hover()
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(out, 'memory-4-too-large.png') })
    await clickTray(app)
    await popup.locator('[data-testid="quick-row"][data-state="done"]').nth(1).waitFor()
    await popup.waitForTimeout(500)
    await popup.screenshot({ path: join(out, 'memory-5-quick-drop.png') })
    await page.getByRole('button', { name: 'Models' }).click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, 'memory-6-models.png') })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByTestId('memory-budget').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'memory-7-settings.png') })
  } finally {
    await app.close()
  }
})
