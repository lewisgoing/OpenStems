import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, MAC, clickTray, launch, trayPage } from './helpers'

/*
 * Lower memory, with the FakeEngine. OPENSTEMS_FAKE_OOM makes a model run out of memory on
 * the pretend GPU, and OPENSTEMS_MEMORY_GB makes the machine act smaller than it is. Nothing
 * here runs a real model.
 */

const COMPUTER = MAC ? 'Mac' : 'PC'
const NOTE = 'BS-RoFormer SW ran on the CPU: not enough GPU memory'

let ctx: Launched

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

test('a model that runs out of GPU memory finishes on the CPU, and the job says so in both windows', async () => {
  ctx = await launch({ OPENSTEMS_FAKE_OOM: 'bs-roformer-sw' })
  const { page, app, fixtures, outputDir } = ctx
  await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])

  // The job is done, not failed, and carries the note under its status.
  const row = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('job-status')).toHaveText('Done')
  await expect(row.getByRole('note')).toHaveText(NOTE)

  // The stems are all there, and the manifest keeps the note.
  await row.click()
  const panel = page.getByRole('complementary', { name: 'Stems' })
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)
  await expect(panel.getByRole('note')).toHaveText(NOTE)
  const manifest = JSON.parse(readFileSync(join(outputDir, 'First Song', 'full-song', 'manifest.json'), 'utf8')) as { notes?: string[] }
  expect(manifest.notes).toEqual([NOTE])

  // The quick-drop window shows the same job with the same note.
  const popup = await trayPage(app)
  await clickTray(app)
  const quick = popup.locator('[data-testid="quick-row"][data-state="done"]')
  await expect(quick).toHaveCount(1)
  await expect(quick.getByRole('note')).toHaveText(NOTE)
  await expect(quick.getByTestId('quick-stem')).toHaveCount(6)
})

test('a job with no memory trouble carries no note', async () => {
  ctx = await launch()
  const { page, fixtures } = ctx
  await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])
  const row = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(row).toHaveCount(1)
  await expect(row.getByRole('note')).toHaveCount(0)
  // Nothing is marked where everything fits.
  await page.getByRole('button', { name: 'Models' }).click()
  await expect(page.getByTestId('model-row').first()).toBeVisible()
  await expect(page.getByTestId('fit-chip')).toHaveCount(0)
  await expect(page.getByTestId('fit-note')).toHaveCount(0)
})

test('a machine made to act as 8 GB marks what is tight or too large, and blocks nothing', async () => {
  ctx = await launch({ OPENSTEMS_MEMORY_GB: '8' })
  const { page, app, fixtures } = ctx

  // The default recipe is tight: a quiet mark, and files still go through.
  const bar = page.getByTestId('recipe-fit')
  await expect(bar).toHaveText('tight fit')

  // In the list, the recipes that need Leap Xe are marked, and the sentence names it.
  await page.getByRole('combobox', { name: 'Recipe' }).click()
  const best = page.getByRole('option', { name: /best vocals/i }).first()
  await expect(best.getByTestId('fit-chip')).toHaveText('too large')
  await expect(best.getByTestId('fit-chip')).toHaveAttribute('title', /Leap Xe.* needs about .* GB\. This (PC|Mac) has about 4\.0 GB of memory for a model\./)
  await best.click()
  await expect(bar).toHaveText(`too large for this ${COMPUTER}`)

  // Too large is advice: the song is separated all the same.
  await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])
  await expect(page.locator('[data-testid="job-row"][data-state="done"]')).toHaveCount(1)

  // The quick-drop window says it in full.
  const popup = await trayPage(app)
  await clickTray(app)
  await expect(popup.getByTestId('fit-note')).toContainText(`This ${COMPUTER} has about 4.0 GB of memory for a model.`)
  await popup.keyboard.press('Escape')

  // Models: what each needs, and the two marks.
  await page.getByRole('button', { name: 'Models' }).click()
  const model = (name: string) => page.getByTestId('model-row').filter({ has: page.getByText(name, { exact: true }) })
  await expect(model('BS-RoFormer SW')).toContainText('needs about 4.0 GB')
  await expect(model('BS-RoFormer SW').getByTestId('fit-chip')).toHaveText('tight fit')
  await expect(page.locator('[data-testid="fit-chip"][data-fit="no"]').first()).toHaveText(`too large for this ${COMPUTER}`)
  await expect(page.getByTestId('budget-note')).toContainText(`This ${COMPUTER} has about 4.0 GB of memory for a model.`)

  // Settings: the budget, and that it is set by hand.
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByTestId('memory-budget')).toHaveText('4.0 GB')
  await expect(page.getByText(/OPENSTEMS_MEMORY_GB is set/)).toBeVisible()
})
