import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, enginePid, lastDrag, launch, processAlive } from './helpers'

let ctx: Launched

test.beforeEach(async () => {
  ctx = await launch()
})

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

const jobs = () => ctx.page.getByTestId('job-row')
const doneJobs = () => ctx.page.locator('[data-testid="job-row"][data-state="done"]')

async function addFiles(...names: string[]) {
  await ctx.page.getByTestId('file-input').setInputFiles(names.map((name) => join(ctx.fixtures, name)))
}

test('an MP3, a FLAC and an MP4 dropped together become three finished jobs', async () => {
  await expect(ctx.page.getByRole('heading', { name: 'Drop audio or video here' })).toBeVisible()
  await addFiles('First Song.mp3', 'Second Song.flac', 'Video Clip.mp4')

  await expect(jobs()).toHaveCount(3)
  await expect(doneJobs()).toHaveCount(3)
  for (const track of ['First Song', 'Second Song', 'Video Clip']) {
    const folder = join(ctx.outputDir, track, 'full-song')
    expect(readdirSync(folder).filter((f) => f.endsWith('.wav'))).toHaveLength(6)
    expect(existsSync(join(folder, 'manifest.json'))).toBe(true)
  }
})

test('stems preview with solo and mute, and drag out as real files', async () => {
  await addFiles('First Song.mp3')
  await doneJobs().click()

  const panel = ctx.page.getByRole('complementary', { name: 'Stems' })
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)

  // Playback starts every stem together through Web Audio.
  await panel.getByRole('button', { name: 'Play' }).click()
  await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible()
  const solo = panel.getByRole('button', { name: 'Solo vocals' })
  await solo.click()
  await expect(solo).toHaveAttribute('aria-pressed', 'true')
  const mute = panel.getByRole('button', { name: 'Mute drums' })
  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  await panel.getByRole('button', { name: 'Pause' }).click()
  await expect(panel.getByRole('button', { name: 'Play' })).toBeVisible()

  // One stem: the main process receives one real file path.
  await panel.getByTestId('drag-stem').first().dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const one = (await lastDrag(ctx.app)) ?? []
  expect(one[0]).toMatch(/First Song - vocals\.wav$/)
  expect(existsSync(one[0] ?? '')).toBe(true)

  // All stems: six real files.
  await panel.getByTestId('drag-all').dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(6)
  for (const path of (await lastDrag(ctx.app)) ?? []) expect(existsSync(path)).toBe(true)
})

test('paths with spaces and non-ASCII characters work end to end', async () => {
  await addFiles(join('ünï cödé 日本語', 'Señor Ω – 夜の曲.wav'))
  await expect(doneJobs()).toContainText('Señor Ω – 夜の曲')
  const folder = join(ctx.outputDir, 'Señor Ω – 夜の曲', 'full-song')
  expect(existsSync(join(folder, 'Señor Ω – 夜の曲 - vocals.wav'))).toBe(true)

  await doneJobs().click()
  await ctx.page.getByTestId('drag-all').dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(6)
  for (const path of (await lastDrag(ctx.app)) ?? []) expect(existsSync(path)).toBe(true)
})

test('recipe, quality, queue controls and the other views', async () => {
  // Pick another recipe and quality, then queue.
  await ctx.page.getByRole('combobox', { name: 'Recipe' }).click()
  await ctx.page.getByRole('option', { name: /Drum kit/ }).click()
  await ctx.page.getByRole('radio', { name: 'Fast' }).click()
  await addFiles('First Song.mp3', 'Second Song.flac')
  await expect(doneJobs()).toHaveCount(2)
  await expect(jobs().first()).toContainText('Drum kit · fast')
  await expect(jobs().first()).toContainText('7 stems')

  // The same file again comes back from the cache.
  await addFiles('First Song.mp3')
  await expect(jobs()).toHaveCount(3)
  await expect(jobs().last().getByTestId('job-status')).toHaveText('Done, from the cache')

  // Remove one job, then clear the rest.
  await jobs().first().hover()
  await jobs().first().getByRole('button', { name: 'Remove from the list' }).click()
  await expect(jobs()).toHaveCount(2)
  await ctx.page.getByRole('button', { name: 'Clear finished' }).click()
  await expect(jobs()).toHaveCount(0)

  // History keeps the results and can show them again.
  await ctx.page.getByRole('button', { name: 'History' }).click()
  await expect(ctx.page.getByTestId('history-row')).toHaveCount(2)
  await ctx.page.getByRole('textbox', { name: 'Search tracks' }).fill('second')
  await expect(ctx.page.getByTestId('history-row')).toHaveCount(1)
  await ctx.page.getByTestId('history-row').click()
  await expect(ctx.page.getByTestId('stem-row')).toHaveCount(7)

  // Models: sizes and licenses are listed.
  await ctx.page.getByRole('button', { name: 'Models' }).click()
  await expect(ctx.page.getByTestId('model-row').first()).toBeVisible()
  await expect(ctx.page.getByText('BS-RoFormer SW', { exact: true })).toBeVisible()

  // Settings persist across a view change.
  await ctx.page.getByRole('button', { name: 'Settings' }).click()
  await ctx.page.getByRole('switch', { name: 'Sum to mix by default' }).click()
  await ctx.page.getByRole('button', { name: 'Queue' }).click()
  await ctx.page.getByRole('button', { name: 'Settings' }).click()
  await expect(ctx.page.getByRole('switch', { name: 'Sum to mix by default' })).toBeChecked()
})

test('a running job can be cancelled and retried', async () => {
  await ctx.app.close()
  ctx = await launch({ OPENSTEMS_FAKE_DELAY: '0.4' })
  await addFiles('First Song.mp3')
  const row = jobs().first()
  await expect(row).toHaveAttribute('data-state', 'running')
  await row.hover()
  await row.getByRole('button', { name: 'Cancel' }).click()
  await expect(row).toHaveAttribute('data-state', 'cancelled')
  expect(existsSync(join(ctx.outputDir, 'First Song', 'full-song'))).toBe(false)
  await row.hover()
  await row.getByRole('button', { name: 'Retry' }).click()
  await expect(row).toHaveAttribute('data-state', /queued|preparing|running/)
})

test('quitting the app leaves no engine process running', async () => {
  const engine = await enginePid(ctx.app)
  const worker = await ctx.page.evaluate(async () => {
    const status = await window.openstems.engine()
    if (status.state !== 'ready') return null
    const response = await fetch(`${status.baseUrl}/v1/system`, {
      headers: { Authorization: `Bearer ${status.token}` },
    })
    return ((await response.json()) as { worker: { pid: number | null } }).worker.pid
  })
  expect(engine).toBeTruthy()
  expect(worker).toBeTruthy()
  expect(processAlive(engine!)).toBe(true)

  await ctx.app.close()
  await expect.poll(() => processAlive(engine!) || processAlive(worker!), { timeout: 20_000 }).toBe(false)
})
