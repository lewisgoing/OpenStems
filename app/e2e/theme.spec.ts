import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import { type Launched, MAC, clickTray, launch, trayPage } from './helpers'

let ctx: Launched

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme)

/** What Electron paints behind the full window, and which theme it reports to the pages. */
function native(app: ElectronApplication): Promise<{ background: string; dark: boolean; source: string }> {
  return app.evaluate(({ BrowserWindow, nativeTheme }) => {
    const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('window=tray'))
    return {
      background: (main?.getBackgroundColor() ?? '').toLowerCase(),
      dark: nativeTheme.shouldUseDarkColors,
      source: nativeTheme.themeSource,
    }
  })
}

test('the theme switch turns both windows light, and the pick survives a restart', async () => {
  // The pick lives in the profile, so the second launch reuses the first one's folder.
  const root = mkdtempSync(join(tmpdir(), 'openstems-e2e-'))
  ctx = await launch({}, { root })
  const { app, page } = ctx
  // Dark until the user picks otherwise.
  expect(await theme(page)).toBe('dark')
  expect(await native(app)).toMatchObject({ background: '#0c0d0f', source: 'dark' })

  const sidebar = page.getByRole('radiogroup', { name: 'Theme' })
  await expect(sidebar.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
  await sidebar.getByRole('radio', { name: 'Light' }).click()
  await expect.poll(() => theme(page)).toBe('light')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 248, 249)')
  // Nothing faded into it: a button had its light color on the first frame after the click.
  const firstFrame = await page.evaluate(async () => {
    const button = document.querySelector('.btn') as HTMLElement
    const dark = document.querySelector('[role="radiogroup"][aria-label="Theme"] [aria-label="Dark"]') as HTMLElement
    dark.click()
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    const onDark = getComputedStyle(button).backgroundColor
    ;(document.querySelector('[role="radiogroup"][aria-label="Theme"] [aria-label="Light"]') as HTMLElement).click()
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    return { onDark, onLight: getComputedStyle(button).backgroundColor }
  })
  // The dark button is the raised gray, the light one white, with nothing in between.
  expect(firstFrame).toEqual({ onDark: 'rgb(24, 27, 32)', onLight: 'rgb(255, 255, 255)' })
  await expect.poll(() => theme(page)).toBe('light')
  // Electron repaints what it draws itself: the window behind the page.
  await expect.poll(async () => (await native(app)).background).toBe('#f7f8f9')
  expect((await native(app)).source).toBe('light')

  // The quick-drop window follows the same pick, with no switch of its own.
  await clickTray(app)
  const popup = await trayPage(app)
  await expect.poll(() => theme(popup)).toBe('light')

  // Settings shows the same pick in words.
  await page.getByRole('button', { name: 'Settings' }).click()
  const words = page.getByRole('radiogroup', { name: 'Light or dark' })
  await expect(words.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')

  await app.close()
  ctx = await launch({}, { root })
  // Light from the first paint: the pick is applied before any window opens.
  expect(await theme(ctx.page)).toBe('light')
  expect((await native(ctx.app)).background).toBe('#f7f8f9')

  // "Match the system" shows whatever the system uses, live.
  await ctx.page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Match the system' }).click()
  await expect.poll(async () => (await native(ctx.app)).source).toBe('system')
  const { dark } = await native(ctx.app)
  await expect.poll(() => theme(ctx.page)).toBe(dark ? 'dark' : 'light')
  if (!MAC) {
    // Windows draws the title bar buttons over the page: they were repainted for the theme.
    await expect.poll(async () => (await native(ctx.app)).background).toBe(dark ? '#0c0d0f' : '#f7f8f9')
  }
})
