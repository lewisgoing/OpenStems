import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { lastDrag, launch } from './helpers'

// The app against the real GPU engine and real models. Not part of CI.
//   REAL_SONG=D:\music\song.mp3 REAL_MODELS=D:\lew-stems\models pnpm e2e -g "real engine"
const song = process.env.REAL_SONG
const models = process.env.REAL_MODELS
test.skip(!song || !models, 'set REAL_SONG and REAL_MODELS to run against the GPU')

test('real engine: a song through the app on the GPU', async () => {
  test.setTimeout(600_000)
  const { app, page } = await launch({
    OPENSTEMS_ENGINE: '',
    OPENSTEMS_FAKE_DELAY: '',
    OPENSTEMS_MODELS_DIR: models ?? '',
  })
  try {
    await page.getByRole('radio', { name: 'Fast' }).click()
    await page.getByTestId('file-input').setInputFiles([song ?? ''])
    const row = page.getByTestId('job-row').first()
    await expect(row).toHaveAttribute('data-state', 'running', { timeout: 120_000 })
    await expect(row).toHaveAttribute('data-state', 'done', { timeout: 300_000 })
    await row.click()

    const panel = page.getByRole('complementary', { name: 'Stems' })
    await expect(panel.getByTestId('stem-row')).toHaveCount(6)
    await panel.getByRole('button', { name: 'Play' }).click()
    await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(1500)
    await panel.getByRole('button', { name: 'Solo drums' }).click()
    await page.waitForTimeout(500)
    if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'real-engine.png') })

    await panel.getByTestId('drag-all').dispatchEvent('dragstart')
    await expect.poll(() => lastDrag(app)).toHaveLength(6)
  } finally {
    await app.close()
  }
})
