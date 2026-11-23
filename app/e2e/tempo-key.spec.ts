import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, launch } from './helpers'

// The tempo and key of a song can be typed over what detection finds: on a song that waits
// in the queue, and on stems that are already written. Manual start is on here, so a song
// waits long enough to be given its figures.
let ctx: Launched

test.beforeEach(async () => {
  ctx = await launch({ OPENSTEMS_AUTO_START: '', OPENSTEMS_FAKE_DELAY: '0.02' })
})

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

const manifest = (folder: string) =>
  JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
    analysis: { bpm: number | null; key: string | null; detected?: unknown }
    stems: { file: string }[]
  }

test('tempo and key: typed before the song runs, and corrected on its stems', async () => {
  const page = ctx.page
  // File names that hold the tempo, so a change has to rename them.
  await page.getByRole('button', { name: 'Settings' }).click()
  const template = page.getByLabel('Naming template')
  await template.fill('{track} {bpm} - {stem}')
  await template.press('Enter')
  await page.getByRole('button', { name: 'Queue' }).click()

  await page.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  const row = page.getByTestId('job-row')
  await expect(row).toHaveAttribute('data-state', 'queued')

  // Before: the waiting song says "auto", and takes what is typed.
  const tempo = row.getByLabel('Tempo in BPM')
  await expect(tempo).toHaveAttribute('placeholder', 'auto')
  await tempo.fill('150')
  await tempo.press('Enter')
  await row.getByLabel('Key').fill('gm')
  await row.getByLabel('Key').press('Enter')
  await expect(row.getByLabel('Key')).toHaveValue('Gm')
  // A figure that is none is refused, and the field shows the song's again.
  await tempo.fill('fast')
  await tempo.press('Enter')
  await expect(page.getByText('The tempo must be a number.')).toBeVisible()
  await expect(row.getByLabel('Tempo in BPM')).toHaveValue('150')

  await page.getByRole('button', { name: 'Start 1 song' }).click()
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toHaveCount(1)
  const folder = join(ctx.outputDir, 'First Song', 'full-song')
  const first = manifest(folder)
  expect(first.analysis.bpm).toBe(150)
  expect(first.analysis.key).toBe('Gm')
  expect(first.stems.every((stem) => stem.file.startsWith('First Song 150.0 - '))).toBe(true)

  // After: the stems panel shows them, and a correction renames the files.
  await done.click()
  const panel = page.getByLabel('Stems')
  await expect(panel.getByLabel('Tempo in BPM')).toHaveValue('150')
  await expect(panel.getByLabel('Key')).toHaveValue('Gm')
  await panel.getByLabel('Tempo in BPM').fill('75')
  await panel.getByLabel('Tempo in BPM').press('Enter')
  await expect.poll(() => manifest(folder).analysis.bpm).toBe(75)
  const after = manifest(folder)
  expect(after.stems.every((stem) => stem.file.startsWith('First Song 75.0 - '))).toBe(true)
  for (const stem of after.stems) expect(existsSync(join(folder, stem.file))).toBe(true)
  expect(readdirSync(folder).some((name) => name.includes('150.0'))).toBe(false)
  await expect(panel.getByLabel('Tempo in BPM')).toHaveValue('75')
  // The renamed stems still play: the panel loaded them again without an error.
  await expect(panel.getByRole('button', { name: /^(Play|Pause)$/ }).first()).toBeEnabled()

  // History shows the corrected figures too.
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByText('First Song').first().click()
  await expect(page.getByLabel('Stems').getByLabel('Tempo in BPM')).toHaveValue('75')
})
