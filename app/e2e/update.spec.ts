import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, clickTray, launch, trayPage, updateOpened } from './helpers'

const RELEASES = 'https://github.com/lewisgoing/OpenStems/releases/latest'

// Self-update with a stand-in for the network: version 0.3.0 is on offer and "downloads" in
// half a second. The real thing, electron-updater against GitHub, needs an installed app.
let ctx: Launched

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

const installed = () =>
  ctx.app.evaluate(() => (globalThis as unknown as { __openstemsE2E: { updateInstalled: boolean } }).__openstemsE2E.updateInstalled)

test('a new version is offered, downloaded on a click, and installed on a restart', async () => {
  ctx = await launch({ OPENSTEMS_E2E_UPDATE: '0.3.0' })
  const { page } = ctx

  // Nothing is said until a check has found something.
  await expect(page.locator('.update-pill')).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('Not checked yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.getByText('Version 0.3.0 is available.')).toBeVisible()

  // The offer is in the title bar of the full window and in the quick-drop window.
  const popup = await trayPage(ctx.app)
  await clickTray(ctx.app)
  await expect(popup.getByRole('button', { name: 'Update', exact: true })).toBeVisible()
  const offer = page.getByRole('button', { name: 'Update to 0.3.0' })
  await expect(offer).toBeVisible()

  // One click downloads; nothing was fetched before it.
  await offer.click()
  const restart = page.getByRole('button', { name: 'Restart to update' }).first()
  await expect(restart).toBeVisible()
  await expect(page.getByText('Version 0.3.0 is downloaded. Restart to finish.')).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Restart', exact: true })).toBeVisible()
  expect(await installed()).toBe(false)

  await restart.click()
  await expect.poll(installed).toBe(true)
})

test('a restart asks first while a job is running', async () => {
  ctx = await launch({ OPENSTEMS_E2E_UPDATE: '0.3.0', OPENSTEMS_FAKE_DELAY: '0.6' })
  const { page } = ctx
  await trayPage(ctx.app) // the quick-drop window is what tells the main process about the queue
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await page.getByRole('button', { name: 'Update to 0.3.0' }).click()
  await expect(page.getByRole('button', { name: 'Restart to update' }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Queue' }).click()
  await page.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  await expect(page.locator('[data-testid="job-row"][data-state="running"]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Restart to update' }).click()
  await expect(page.getByText('1 job is queued or running.', { exact: false })).toBeVisible()
  expect(await installed()).toBe(false)
  await page.getByRole('button', { name: 'Later' }).click()
  expect(await installed()).toBe(false)

  await page.getByRole('button', { name: 'Restart to update' }).click()
  await page.getByRole('button', { name: 'Restart now' }).click()
  await expect.poll(installed).toBe(true)
})

// An app that cannot install an update by itself (an unsigned Mac app) still says that a new
// version is out, and its one button opens the release page. The stand-in is the same on
// every system, so this runs on Windows too.
test('an update the app cannot install itself opens the release page and stays on offer', async () => {
  ctx = await launch({ OPENSTEMS_E2E_UPDATE: '0.3.0', OPENSTEMS_E2E_UPDATE_MANUAL: '1' })
  const { page } = ctx
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.getByText(/Version 0\.3\.0 is available\./)).toBeVisible()
  const found = await page.evaluate(() => window.openstems.updates())
  expect(found.state).toBe('available')
  expect(found.manual).toBe(true)
  expect(found.url).toBe(RELEASES)

  // The quick-drop window carries the offer too.
  const popup = await trayPage(ctx.app)
  await clickTray(ctx.app)
  await expect(popup.locator('.update-pill')).toBeVisible()

  // Nothing is opened before the click. The click opens the page (here: records it).
  expect(await updateOpened(ctx.app)).toBeNull()
  await page.locator('.update-pill').click()
  await expect.poll(() => updateOpened(ctx.app)).toBe(RELEASES)

  // There is no download and no restart: the offer stays as it was, ready to be used again.
  const after = await page.evaluate(() => window.openstems.updates())
  expect(after.state).toBe('available')
  expect(after.error).toBeUndefined()
  await expect(page.locator('.update-pill')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Restart to update' })).toHaveCount(0)
  expect(await installed()).toBe(false)
  // A restart that is asked for anyway is refused: there is nothing to install.
  expect((await page.evaluate(() => window.openstems.installUpdate(true))).started).toBe(false)
})
