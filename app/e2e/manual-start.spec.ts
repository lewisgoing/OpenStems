import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, MOD, clickTray, launch, trayPage, trayState } from './helpers'

// Manual start is the default: songs added to the queue wait until Start is pressed. The
// other suites turn it off through OPENSTEMS_AUTO_START; here the setting is in charge.
let ctx: Launched

test.beforeEach(async () => {
  ctx = await launch({ OPENSTEMS_AUTO_START: '', OPENSTEMS_FAKE_DELAY: '0.05' })
})

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

const rows = () => ctx.page.getByTestId('job-row')
const done = () => ctx.page.locator('[data-testid="job-row"][data-state="done"]')
const add = (...names: string[]) =>
  ctx.page.getByTestId('file-input').setInputFiles(names.map((name) => join(ctx.fixtures, name)))

test('added songs wait in the queue, and one press of Start runs them all', async () => {
  await add('First Song.mp3', 'Second Song.flac', 'Video Clip.mp4')
  await expect(rows()).toHaveCount(3)
  for (const row of await rows().all()) {
    await expect(row).toHaveAttribute('data-state', 'queued')
    await expect(row.getByTestId('job-status')).toHaveText('Ready to start')
  }
  // Nothing has run, and the tray icon does not claim that work is going on.
  await ctx.page.waitForTimeout(600)
  await expect(done()).toHaveCount(0)
  expect(existsSync(join(ctx.outputDir, 'First Song'))).toBe(false)
  await trayPage(ctx.app)
  expect((await trayState(ctx.app)).icon).toBe('idle')

  await ctx.page.getByRole('button', { name: 'Start 3 songs' }).click()
  await expect(done()).toHaveCount(3)
  // With nothing left to start, the button is gone.
  await expect(ctx.page.getByRole('button', { name: /^Start \d/ })).toHaveCount(0)
})

test('one song can be started by itself, and Ctrl+Enter starts the rest', async () => {
  await add('First Song.mp3', 'Second Song.flac')
  await expect(rows()).toHaveCount(2)
  await rows().nth(1).hover()
  await rows().nth(1).getByRole('button', { name: 'Start this one' }).click()
  await expect(done()).toHaveCount(1)
  await expect(rows().nth(0)).toHaveAttribute('data-state', 'queued')
  await expect(ctx.page.getByRole('button', { name: 'Start 1 song' })).toBeVisible()

  // Cmd+Enter on a Mac.
  await ctx.page.keyboard.press(`${MOD}+Enter`)
  await expect(done()).toHaveCount(2)
})

test('the quick-drop window waits for Start too', async () => {
  const popup = await trayPage(ctx.app)
  await clickTray(ctx.app)
  await popup.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  const row = popup.getByTestId('quick-row')
  await expect(row).toHaveAttribute('data-state', 'queued')
  await expect(row.getByTestId('quick-status')).toHaveText('Ready to start')
  await popup.getByRole('button', { name: 'Start 1 song' }).click()
  await expect(popup.locator('[data-testid="quick-row"][data-state="done"]')).toHaveCount(1)
  await expect(row.getByTestId('quick-stem')).toHaveCount(6)
})

test('with "Start songs automatically" on, songs run as they are added', async () => {
  await ctx.page.getByRole('button', { name: 'Settings' }).click()
  const auto = ctx.page.getByRole('switch', { name: 'Start songs automatically' })
  await expect(auto).not.toBeChecked()
  await auto.click()
  await expect(auto).toBeChecked()
  await ctx.page.getByRole('button', { name: 'Queue' }).click()
  await add('First Song.mp3')
  await expect(done()).toHaveCount(1)
})
