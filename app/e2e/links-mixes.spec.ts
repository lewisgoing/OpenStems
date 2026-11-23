import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, expect, test } from '@playwright/test'
import { type Launched, clickTray, lastDrag, launch, setClipboard, trayPage } from './helpers'

// Links are fetched by the FakeEngine's stand-in: no network. `slow` in the address takes a
// few seconds, `fail` fails, and the song is named after the address.

let ctx: Launched

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

/** What Ctrl+V does: a paste event carrying text, on the page. */
const paste = (page: Page, text: string) =>
  page.evaluate((value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)

test('a pasted link is fetched, queued and separated like a dropped file', async () => {
  ctx = await launch()
  const { page } = ctx
  const jobs = page.getByTestId('job-row')
  const links = page.getByTestId('link-row')

  // The button takes what is on the clipboard.
  await setClipboard(ctx.app, 'https://example.com/slow/Night-Drive')
  await page.getByRole('button', { name: 'Paste link' }).click()
  await expect(links).toHaveCount(1)
  await expect(links.getByText('Night Drive')).toBeVisible()
  await expect(links.getByTestId('link-status')).toHaveText('Fetching from example.com')
  await expect(links.getByRole('progressbar')).toBeVisible()

  // Once it is here it is a job like any other, named after the song.
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toHaveCount(1, { timeout: 30_000 })
  await expect(links).toHaveCount(0)
  await expect(done.getByText('Night Drive')).toBeVisible()
  await expect(done.getByText('6 stems')).toBeVisible()

  // Ctrl+V does the same. A link that cannot be fetched stays, with the reason.
  await paste(page, 'https://example.com/fail/nothing-here')
  const failed = page.locator('[data-testid="link-row"][data-state="failed"]')
  await expect(failed).toHaveCount(1)
  await expect(failed.getByTestId('link-status')).toHaveText('OpenStems cannot fetch a song from this page.')
  await expect(jobs).toHaveCount(1)
  await failed.hover()
  await failed.getByRole('button', { name: 'Dismiss' }).click()
  await expect(links).toHaveCount(0)

  // A fetch can be cancelled, and then nothing is queued.
  await paste(page, 'https://example.com/slow/Second-Thoughts')
  await expect(links.getByText('Second Thoughts')).toBeVisible()
  await links.hover()
  await links.getByRole('button', { name: 'Cancel' }).click()
  await expect(links).toHaveCount(0)
  await page.waitForTimeout(800)
  await expect(jobs).toHaveCount(1)

  // With nothing copied, the button says what it needs.
  await setClipboard(ctx.app, 'not a link')
  await page.getByRole('button', { name: 'Paste link' }).click()
  await expect(page.getByText("Copy a song's link first, then paste it here.")).toBeVisible()
})

test('a link dragged in from a browser is fetched, and a pasted link waits for Start when songs do', async () => {
  ctx = await launch({ OPENSTEMS_AUTO_START: '' })
  const { page } = ctx
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/uri-list', '# from a browser\r\nhttps://example.com/songs/Dragged-In\r\n')
    data.setData('text/plain', 'https://example.com/songs/Dragged-In')
    for (const type of ['dragenter', 'dragover', 'drop']) {
      window.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
    }
  })
  const row = page.getByTestId('job-row')
  await expect(row).toHaveCount(1, { timeout: 30_000 })
  await expect(row.getByText('Dragged In')).toBeVisible()
  await expect(row.getByTestId('job-status')).toHaveText('Ready to start')
  await page.getByRole('button', { name: 'Start 1 song' }).click()
  await expect(page.locator('[data-testid="job-row"][data-state="done"]')).toHaveCount(1, { timeout: 30_000 })
})

test('in the quick-drop window, stems are mixed, heard together and dragged out as one file', async () => {
  ctx = await launch()
  const popup = await trayPage(ctx.app)
  await clickTray(ctx.app)

  // A link pasted here arrives like a dropped song.
  await setClipboard(ctx.app, 'https://example.com/songs/Night-Drive')
  await popup.getByRole('button', { name: 'Paste link' }).click()
  const done = popup.locator('[data-testid="quick-row"][data-state="done"]')
  await expect(done).toHaveCount(1, { timeout: 30_000 })
  await expect(done.getByText('Night Drive')).toBeVisible()
  const pills = done.getByTestId('quick-stem')
  await expect(pills).toHaveCount(6)

  // Mixing starts with every stem in.
  await done.getByTestId('quick-mix').click()
  const bar = done.getByTestId('mix-bar')
  await expect(bar.getByTestId('mix-label')).toHaveText('Click a stem to leave it out')
  await expect(bar.getByTestId('mix-drag')).toHaveCount(0)

  // Leave the vocals out: the engine writes the rest as one file, which drags out.
  await pills.filter({ hasText: 'vocals' }).click()
  await expect(pills.filter({ hasText: 'vocals' })).toHaveAttribute('aria-pressed', 'false')
  await expect(bar.getByTestId('mix-label')).toHaveText('No vocals')
  const handle = bar.getByTestId('mix-drag')
  await expect(handle).toHaveAttribute('data-state', 'ready')
  await expect(handle).toHaveText('Drag mix')
  await handle.dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const mix = ((await lastDrag(ctx.app)) ?? [])[0] ?? ''
  expect(mix).toMatch(/Mixes[\\/]Night Drive - no vocals\.wav$/)
  expect(existsSync(mix)).toBe(true)

  // Hear it: every stem is loaded and they start together.
  await bar.getByRole('button', { name: 'Play the mix' }).click()
  await expect(bar.getByRole('button', { name: 'Pause the mix' })).toBeVisible({ timeout: 15_000 })
  await expect(pills.filter({ hasText: 'drums' }).locator('.audition-bars')).toHaveCount(1)
  await expect(pills.filter({ hasText: 'vocals' }).locator('.audition-bars')).toHaveCount(0)
  await bar.getByRole('button', { name: 'Pause the mix' }).click()
  await expect(bar.getByRole('button', { name: 'Play the mix' })).toBeVisible()

  // Two stems together are named for what is in them.
  for (const name of ['guitar', 'piano', 'other']) await pills.filter({ hasText: name }).click()
  await expect(bar.getByTestId('mix-label')).toHaveText('Drums + bass')
  await expect(handle).toHaveAttribute('data-state', 'ready')
  await handle.dispatchEvent('dragstart')
  await expect.poll(async () => ((await lastDrag(ctx.app)) ?? [])[0] ?? '').toMatch(/Night Drive - drums \+ bass\.wav$/)

  // Turning mixing off brings back listening to one stem.
  await done.getByTestId('quick-mix').click()
  await expect(done.getByTestId('mix-bar')).toHaveCount(0)
  await pills.filter({ hasText: 'bass' }).click()
  await expect(pills.filter({ hasText: 'bass' })).toHaveAttribute('data-audition', 'playing')
})

test('in the full window, what solo and mute leave audible drags out as one file', async () => {
  ctx = await launch()
  const { page } = ctx
  await page.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  await page.locator('[data-testid="job-row"][data-state="done"]').click()
  const panel = page.getByRole('complementary', { name: 'Stems' })
  await expect(panel.getByTestId('drag-mix')).toHaveCount(0)

  await panel.getByRole('button', { name: 'Mute vocals' }).click()
  const handle = panel.getByTestId('drag-mix')
  await expect(handle).toHaveText('Drag mix')
  await handle.dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const mix = ((await lastDrag(ctx.app)) ?? [])[0] ?? ''
  expect(mix).toMatch(/Mixes[\\/]First Song - no vocals\.wav$/)
  expect(existsSync(mix)).toBe(true)

  // A mute made before listening is still a mute once the stems play.
  await panel.getByRole('button', { name: 'Play' }).click()
  await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Mute vocals' })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByTestId('drag-mix')).toHaveText('Drag mix')
})
