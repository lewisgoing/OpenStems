import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, MAC, clickTray, launch, trayPage, trayState } from './helpers'

// A right-click on a row of the queue, in the full window and the quick-drop window.

let ctx: Launched

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

test('a finished song: show its stems from the menu, then take it off the list', async () => {
  ctx = await launch()
  const { page, fixtures } = ctx
  await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])
  const row = page.locator('[data-testid="job-row"][data-state="done"]')
  await row.click({ button: 'right' })
  const menu = page.getByTestId('row-menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Show stems', 'Trim', /^Show in (Explorer|Finder)$/, /^Show the original in/, 'Remove from the list'])
  await menu.getByRole('menuitem', { name: 'Show stems' }).click()
  await expect(page.getByTestId('stem-row').first()).toBeVisible()

  await row.click({ button: 'right' })
  await page.getByTestId('row-menu').getByRole('menuitem', { name: 'Remove from the list' }).click()
  await expect(page.getByTestId('job-row')).toHaveCount(0)
  // The panel of a song taken off the list goes with it.
  await expect(page.getByTestId('stem-row')).toHaveCount(0)
})

test('a waiting song moves to the top from its menu', async () => {
  // Manual start: songs wait, so there is an order to change.
  ctx = await launch({ OPENSTEMS_AUTO_START: '' })
  const { page, fixtures } = ctx
  await page.getByTestId('file-input').setInputFiles(['First Song.mp3', 'Second Song.flac'].map((name) => join(fixtures, name)))
  const rows = page.locator('[data-testid="job-row"][data-state="queued"]')
  await expect(rows).toHaveCount(2)
  // The newest is first; the handle to drag a waiting song is in the order songs run in.
  await expect(rows.first()).toContainText('Second Song')
  await expect(page.getByRole('button', { name: /^Reorder / })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Sort the queue' }).click()
  await page.getByRole('option', { name: /^Run order/ }).click()
  await expect(page.getByRole('button', { name: /^Reorder / })).toHaveCount(2)
  await expect(rows.first()).toContainText('First Song')
  await rows.nth(1).click({ button: 'right' })
  const menu = page.getByTestId('row-menu')
  // Already last: nowhere further down to go.
  await expect(menu.getByRole('menuitem', { name: 'Move to the bottom' })).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Move to the top' }).click()
  await expect(rows.first()).toContainText('Second Song')
})

test('the quick-drop window has the menu, and Escape closes the menu, not the window', async () => {
  ctx = await launch()
  await clickTray(ctx.app)
  const popup = await trayPage(ctx.app)
  await expect.poll(async () => (await trayState(ctx.app)).popupVisible).toBe(true)
  await popup.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  const row = popup.locator('[data-testid="quick-row"][data-state="done"]')
  await row.click({ button: 'right' })
  const menu = popup.getByTestId('row-menu')
  await expect(menu.getByRole('menuitem', { name: 'Remove from the list' })).toBeVisible()

  await popup.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  expect((await trayState(ctx.app)).popupVisible).toBe(true)

  await row.click({ button: 'right' })
  await popup.getByTestId('row-menu').getByRole('menuitem', { name: 'Remove from the list' }).click()
  await expect(popup.getByTestId('quick-row')).toHaveCount(0)
})

test('Shift+F10 on a button in a row opens the menu at the row', async () => {
  // A Windows convention: a Mac has no key for a context menu (Control-click is the click).
  test.skip(MAC, 'Shift+F10 is a Windows key')
  ctx = await launch()
  const { page, fixtures } = ctx
  await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])
  const row = page.locator('[data-testid="job-row"][data-state="done"]')
  await row.getByRole('button', { name: 'Remove from the list' }).focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByTestId('row-menu')
  await expect(menu).toBeVisible()
  // At the row, not in a corner of the window.
  const [rowBox, menuBox] = [await row.boundingBox(), await menu.boundingBox()]
  expect(menuBox && rowBox && menuBox.y >= rowBox.y && menuBox.y <= rowBox.y + rowBox.height).toBe(true)
})
