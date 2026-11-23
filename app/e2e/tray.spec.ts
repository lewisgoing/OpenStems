import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  type Launched,
  clickTray,
  doubleClickTray,
  enginePid,
  lastDrag,
  launch,
  mainPage,
  notices,
  processAlive,
  trayPage,
  trayState,
  workArea,
} from './helpers'

let ctx: Launched

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

const rows = (page: import('@playwright/test').Page) => page.getByTestId('quick-row')
const song = (name: string) => join(ctx.fixtures, name)

test('a click on the tray icon opens the quick-drop window by the taskbar, and a second click hides it', async () => {
  ctx = await launch()
  const popup = await trayPage(ctx.app)
  expect((await trayState(ctx.app)).popupVisible).toBe(false)

  await clickTray(ctx.app)
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(true)
  await expect(popup.getByRole('heading', { name: 'Drop a song here' })).toBeVisible()

  // Inside the work area with the usual margin, against the taskbar.
  const state = await trayState(ctx.app)
  const area = await workArea(ctx.app)
  const bounds = state.popupBounds!
  expect(bounds.width).toBe(380)
  expect(bounds.height).toBe(500)
  expect(bounds.x).toBeGreaterThanOrEqual(area.x + 12)
  expect(bounds.y).toBeGreaterThanOrEqual(area.y + 12)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width - 12)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height - 12)

  // Escape puts it away; so does a second click on the icon.
  await popup.keyboard.press('Escape')
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(false)
  await clickTray(ctx.app)
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(true)
  await clickTray(ctx.app)
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(false)
})

test('a song dropped on the quick-drop window comes back as stems that drag out as real files', async () => {
  ctx = await launch({ OPENSTEMS_FAKE_DELAY: '0.1' })
  const popup = await trayPage(ctx.app)
  await clickTray(ctx.app)
  await popup.getByTestId('file-input').setInputFiles([song('First Song.mp3')])

  // The icon says work is going on, then the stems arrive.
  await expect.poll(async () => (await trayState(ctx.app)).icon).toBe('busy')
  const done = popup.locator('[data-testid="quick-row"][data-state="done"]')
  await expect(done).toHaveCount(1)
  await expect(done.getByTestId('quick-stem')).toHaveCount(6)
  // The window was open when they arrived, so there is nothing left to announce.
  await expect.poll(async () => (await trayState(ctx.app)).icon).toBe('idle')

  // One stem: the main process receives one real file path.
  await done.getByTestId('quick-stem').first().dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const one = (await lastDrag(ctx.app)) ?? []
  expect(one[0]).toMatch(/First Song - vocals\.wav$/)
  expect(existsSync(one[0] ?? '')).toBe(true)

  // A click plays the stem; a second click stops it. Another stem takes over from the first.
  const vocals = done.getByTestId('quick-stem').first()
  const drums = done.getByTestId('quick-stem').nth(1)
  await vocals.click()
  await expect(vocals).toHaveAttribute('data-audition', 'playing')
  await drums.click()
  await expect(drums).toHaveAttribute('data-audition', 'playing')
  await expect(vocals).not.toHaveAttribute('data-audition')
  await drums.click()
  await expect(drums).not.toHaveAttribute('data-audition')
  // The window was open when the stems arrived: no notification.
  expect(await notices(ctx.app)).toEqual([])

  // Every stem at once.
  await done.getByTestId('quick-drag-all').dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(6)
  for (const path of (await lastDrag(ctx.app)) ?? []) expect(existsSync(path)).toBe(true)

  // The full window shows the same job.
  await expect(ctx.page.locator('[data-testid="job-row"][data-state="done"]')).toHaveCount(1)
})

test('the two windows share the recipe and the queue, and the icon announces stems finished out of sight', async () => {
  ctx = await launch({ OPENSTEMS_FAKE_DELAY: '0.1' })
  const popup = await trayPage(ctx.app)

  // A recipe picked in the quick-drop window is the one the full window runs.
  await clickTray(ctx.app)
  await popup.getByRole('combobox', { name: 'Recipe' }).click()
  await popup.getByRole('option', { name: /Drum kit/ }).click()
  await popup.getByRole('radio', { name: 'Fast' }).click()
  await expect(ctx.page.getByRole('combobox', { name: 'Recipe' })).toContainText('Drum kit')
  await expect(ctx.page.getByRole('radio', { name: 'Fast' })).toBeChecked()

  // With the quick-drop window hidden, a job from the full window still reaches the icon.
  await clickTray(ctx.app)
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(false)
  // Minimized, the full window does not have the user's attention either. (Which window
  // Windows focuses after another one hides is a matter of timing; minimizing is not.)
  await ctx.app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.isVisible()) window.minimize()
  })
  await expect
    .poll(() => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused())))
    .toBe(false)
  await ctx.page.getByTestId('file-input').setInputFiles([song('Second Song.flac')])
  await expect(ctx.page.locator('[data-testid="job-row"][data-state="done"]')).toHaveCount(1)
  await expect.poll(async () => (await trayState(ctx.app)).icon).toBe('ready')
  expect((await trayState(ctx.app)).tooltip).toBe('OpenStems: Second Song is ready, 7 stems')
  // And a notification says so, once.
  expect(await notices(ctx.app)).toEqual(['Second Song is ready'])

  // Opening the quick-drop window shows it, newest first, and the mark has done its job.
  await clickTray(ctx.app)
  await expect(rows(popup).first()).toContainText('Second Song')
  await expect(rows(popup).first()).toContainText('Drum kit · fast')
  await expect(rows(popup).first().getByTestId('quick-stem')).toHaveCount(7)
  await expect.poll(async () => (await trayState(ctx.app)).icon).toBe('idle')
})

test('closing the window leaves the app in the tray with the engine running, and the tray brings it back', async () => {
  ctx = await launch()
  const popup = await trayPage(ctx.app)
  const engine = await enginePid(ctx.app)
  expect(engine).toBeTruthy()

  await ctx.page.close()
  await expect.poll(async () => (await trayState(ctx.app)).mainOpen).toBe(false)
  expect(processAlive(engine!)).toBe(true)
  // Said once, the first time.
  await expect.poll(() => notices(ctx.app)).toEqual(['OpenStems is still running'])

  // The quick-drop window works on its own.
  await clickTray(ctx.app)
  await popup.getByTestId('file-input').setInputFiles([song('First Song.mp3')])
  await expect(popup.locator('[data-testid="quick-row"][data-state="done"]')).toHaveCount(1)

  // "Open the full app" brings the full window back, with the job in its queue.
  await popup.getByRole('button', { name: 'Open the full app' }).click()
  const main = await mainPage(ctx.app)
  await expect(main.locator('[data-testid="job-row"][data-state="done"]')).toHaveCount(1)
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(false)

  // Closing it again says nothing new; a double click on the icon opens it once more.
  await main.close()
  await expect.poll(async () => (await trayState(ctx.app)).mainOpen).toBe(false)
  expect(await notices(ctx.app)).toHaveLength(1)
  await doubleClickTray(ctx.app)
  await mainPage(ctx.app)
  await expect.poll(async () => (await trayState(ctx.app)).mainOpen).toBe(true)

  // Quitting still leaves no engine behind.
  await ctx.app.close()
  await expect.poll(() => processAlive(engine!), { timeout: 20_000 }).toBe(false)
})

test('with "Keep running in the tray" off, closing the window quits the app', async () => {
  // The preference lives in the profile, so the second launch reuses the first one's folder.
  const root = mkdtempSync(join(tmpdir(), 'openstems-e2e-'))
  ctx = await launch({}, { root })
  await ctx.page.getByRole('button', { name: 'Settings' }).click()
  const keep = ctx.page.getByRole('switch', { name: 'Keep running in the tray' })
  await expect(keep).toBeChecked()
  await keep.click()
  await expect(keep).not.toBeChecked()

  // "Start with Windows" is a switch too; in tests it never reaches the registry.
  const login = ctx.page.getByRole('switch', { name: 'Start with Windows' })
  await login.click()
  await expect(login).toBeChecked()
  await login.click()
  await expect(login).not.toBeChecked()
  await ctx.app.close()

  ctx = await launch({}, { root })
  const engine = await enginePid(ctx.app)
  const closed = ctx.app.waitForEvent('close')
  await ctx.page.close()
  await closed
  await expect.poll(() => processAlive(engine!), { timeout: 20_000 }).toBe(false)
})

test('started with --tray, the app opens no window until the tray is used', async () => {
  ctx = await launch({}, { args: ['--tray'], window: 'tray' })
  const popup = ctx.page
  expect(new URL(popup.url()).searchParams.get('window')).toBe('tray')
  const state = await trayState(ctx.app)
  expect(state.mainOpen).toBe(false)
  expect(state.popupVisible).toBe(false)

  await clickTray(ctx.app)
  await expect(popup.getByRole('heading', { name: 'Drop a song here' })).toBeVisible({ timeout: 90_000 })
  await popup.getByTestId('file-input').setInputFiles([song('First Song.mp3')])
  await expect(popup.locator('[data-testid="quick-row"][data-state="done"]')).toHaveCount(1)
})
