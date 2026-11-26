import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, clickTray, lastDrag, launch, trayPage, trayState } from './helpers'

// Empty stems: a song through the six-stem recipe with nothing in four of them
// (`OPENSTEMS_FAKE_EMPTY` leaves those FakeEngine stems a hiss). They are written, and left
// out of the stems panel, the quick-drop window and the handles that drag every stem, until
// they are asked for. EMPTY_SHOTS=<folder> also saves pictures for design review.

let ctx: Launched

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

const EMPTY = ['bass', 'guitar', 'piano', 'other']
const shots = process.env.EMPTY_SHOTS
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.waitForTimeout(600) // entrances over
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

test('empty stems are written, and left out of the lists until asked for', async () => {
  ctx = await launch({ OPENSTEMS_FAKE_EMPTY: EMPTY.join(',') })
  const { page } = ctx
  await page.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toHaveCount(1, { timeout: 30_000 })

  // Six files on disk, whatever is shown.
  const folder = join(ctx.outputDir, 'First Song', 'full-song')
  expect(readdirSync(folder).filter((f) => f.endsWith('.wav'))).toHaveLength(6)

  // The row's handle counts and carries the two with sound.
  const handle = done.getByRole('button', { name: 'Drag all stems of First Song' })
  await expect(handle).toHaveText('2 stems')
  await handle.dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(2)

  // The panel lists those two, and names the rest in one line.
  await done.click()
  const panel = page.getByRole('complementary', { name: 'Stems' })
  await expect(panel.getByTestId('stem-row')).toHaveCount(2)
  await expect(panel.getByTestId('empty-stems')).toContainText('4 empty: bass, guitar, piano, other')
  await panel.getByTestId('drag-all').dispatchEvent('dragstart')
  await expect.poll(async () => (await lastDrag(ctx.app))?.map((path) => path.replace(/^.* - /, ''))).toEqual(['vocals.wav', 'drums.wav'])
  await shot(page, 'empty-1-panel-hidden')

  // Shown, they are where the recipe puts them, and every stem drags again.
  await panel.getByRole('button', { name: 'Show empty stems' }).click()
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)
  await expect(panel.locator('[data-testid="stem-row"][data-empty]')).toHaveCount(4)
  await panel.getByTestId('drag-all').dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(6)
  expect(((await lastDrag(ctx.app)) ?? []).every((path) => existsSync(path))).toBe(true)
  await shot(page, 'empty-2-panel-shown')
  await panel.getByRole('button', { name: 'Hide empty stems' }).click()
  await expect(panel.getByTestId('stem-row')).toHaveCount(2)

  // The quick-drop window: two pills and "+4 empty".
  const popup = await trayPage(ctx.app)
  await clickTray(ctx.app)
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(true)
  const row = popup.getByTestId('quick-row')
  await expect(row.getByTestId('quick-stem')).toHaveCount(2)
  await expect(row.getByTestId('quick-empty')).toHaveText('+4 empty')
  await expect(row.getByTestId('quick-drag-all')).toHaveText('2 stems')
  await shot(popup, 'empty-3-tray-hidden')
  await row.getByTestId('quick-empty').click()
  await expect(row.getByTestId('quick-stem')).toHaveCount(6)
  await expect(row.locator('[data-testid="quick-stem"][data-empty]')).toHaveCount(4)
  await expect(row.getByTestId('quick-drag-all')).toHaveText('6 stems')
  await shot(popup, 'empty-4-tray-shown')
  await row.getByTestId('quick-empty').click()
  await expect(row.getByTestId('quick-stem')).toHaveCount(2)

  // The setting, beside Sum to mix: off, both windows show every stem and say nothing more.
  await page.getByRole('button', { name: 'Settings' }).click()
  const hide = page.getByRole('switch', { name: 'Hide empty stems' })
  await expect(hide).toBeChecked()
  await hide.scrollIntoViewIfNeeded()
  await shot(page, 'empty-5-settings')
  await hide.click()
  await expect(hide).not.toBeChecked()
  await expect(row.getByTestId('quick-stem')).toHaveCount(6)
  await expect(row.getByTestId('quick-empty')).toHaveCount(0)
  await page.getByRole('button', { name: 'Queue' }).click()
  await expect(done.getByRole('button', { name: 'Drag all stems of First Song' })).toHaveText('6 stems')
  await done.click()
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)
  await expect(panel.getByTestId('empty-stems')).toHaveCount(0)
})

test('a song with something in every stem shows them all', async () => {
  ctx = await launch()
  const { page } = ctx
  await page.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done.getByRole('button', { name: 'Drag all stems of First Song' })).toHaveText('6 stems', { timeout: 30_000 })
  await done.click()
  const panel = page.getByRole('complementary', { name: 'Stems' })
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)
  await expect(panel.getByTestId('empty-stems')).toHaveCount(0)
})

test('a stem hidden by hand stays hidden: after the panel is left, in the history and in both windows', async () => {
  ctx = await launch()
  const { page } = ctx
  await page.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toHaveCount(1, { timeout: 30_000 })
  const folder = join(ctx.outputDir, 'First Song', 'full-song')
  const hiddenIn = () =>
    (JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { stems: { name: string; hidden?: boolean }[] }).stems.filter((s) => s.hidden).map((s) => s.name)

  await done.click()
  const panel = page.getByRole('complementary', { name: 'Stems' })
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)
  await expect(panel.getByTestId('empty-stems')).toHaveCount(0)

  // Hide waits on the row until the pointer is there.
  const drums = panel.getByTestId('stem-row').filter({ hasText: 'drums' })
  await drums.hover()
  await drums.getByRole('button', { name: 'Hide drums' }).click()
  await expect(panel.getByTestId('stem-row')).toHaveCount(5)
  await expect(panel.getByTestId('empty-stems')).toContainText('1 hidden: drums')
  await expect.poll(hiddenIn).toEqual(['drums'])
  // Every file is still there: hidden is not deleted.
  expect(readdirSync(folder).filter((f) => f.endsWith('.wav'))).toHaveLength(6)
  // What is dragged, from the panel and from the row, is what is shown.
  await panel.getByTestId('drag-all').dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(5)
  await expect(done.getByRole('button', { name: 'Drag all stems of First Song' })).toHaveText('5 stems')
  await shot(page, 'hide-1-panel')

  // Leave the song's page and come back, by the history as well: still hidden.
  await panel.getByRole('button', { name: 'Close' }).click()
  await done.click()
  await expect(panel.getByTestId('stem-row')).toHaveCount(5)
  await page.getByRole('button', { name: 'History' }).click()
  const past = page.getByTestId('history-row')
  await expect(past.getByRole('button', { name: 'Drag all stems of First Song' })).toHaveText('5 stems')
  await expect(past).not.toContainText('drums')
  await past.click()
  await expect(panel.getByTestId('stem-row')).toHaveCount(5)
  await expect(panel.getByTestId('empty-stems')).toContainText('1 hidden: drums')

  // The quick-drop window leaves it out too, under the same word.
  const popup = await trayPage(ctx.app)
  await clickTray(ctx.app)
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(true)
  const row = popup.getByTestId('quick-row')
  await expect(row.getByTestId('quick-stem')).toHaveCount(5)
  await expect(row.getByTestId('quick-empty')).toHaveText('+1 hidden')

  // The way back: show what is hidden, and the stem's own row brings it home.
  await panel.getByRole('button', { name: 'Show hidden stems' }).click()
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)
  await shot(page, 'hide-2-panel-shown')
  await panel.getByRole('button', { name: 'Show drums again' }).click()
  await expect(panel.getByTestId('empty-stems')).toHaveCount(0)
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)
  await expect.poll(hiddenIn).toEqual([])
  await expect(row.getByTestId('quick-stem')).toHaveCount(6)
})
