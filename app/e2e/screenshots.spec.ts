import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@playwright/test'
import { captureAroundPopup, clickTray, launch, trayPage } from './helpers'

// Design review screenshots. Run with: SHOTS=1 pnpm e2e -g screenshots
test.skip(process.env.SHOTS !== '1', 'set SHOTS=1 to capture screenshots')

test('screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page, fixtures } = await launch({ OPENSTEMS_FAKE_DELAY: '0.15' })
  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) })
  try {
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
  } finally {
    await app.close()
  }
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
    // The real screen: frame, shadow and where the window sits by the taskbar.
    await captureAroundPopup(app, join(out, 'tray-on-screen.png'))
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
