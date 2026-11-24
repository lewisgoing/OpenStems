import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, expect, test } from '@playwright/test'
import { type Launched, launch } from './helpers'

// The welcome on a first start: folders, format, models. The FakeEngine has every model, so
// `OPENSTEMS_E2E_WELCOME=1` shows it anyway, and the folder picker is a stand-in.

let ctx: Launched

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

function pickFolderReturns(app: ElectronApplication, folder: string): Promise<void> {
  return app.evaluate((_electron, folder) => {
    ;(globalThis as unknown as { __openstemsE2E: { pickFolder: string | null } }).__openstemsE2E.pickFolder = folder
  }, folder)
}

test('the welcome sets the folders and the format, and they are the settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openstems-e2e-'))
  // The folders and auto start come from the settings file here, not from the environment,
  // which would win over what the welcome saves. An empty value leaves the file in charge.
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'settings.json'), JSON.stringify({ output_dir: join(root, 'outputs') }))
  ctx = await launch({ OPENSTEMS_E2E_WELCOME: '1', OPENSTEMS_OUTPUT_DIR: '', OPENSTEMS_AUTO_START: '' }, { root })
  const { app, page } = ctx
  const welcome = page.getByTestId('welcome')
  await expect(welcome.getByRole('heading', { name: 'Where should your files go?' })).toBeVisible()
  // The free space of the drive the temp folder is on, read through statfs.
  await expect(welcome.getByTestId('welcome-folder-stems').getByTestId('free-space')).toHaveText(/ (GB|MB) free$/)

  // A folder that does not exist yet: the space is that of its drive, and the engine makes it.
  const elsewhere = join(root, 'Stems elsewhere')
  await pickFolderReturns(app, elsewhere)
  await welcome.getByTestId('welcome-folder-stems').getByRole('button', { name: 'Change' }).click()
  await expect(welcome.getByTestId('welcome-folder-stems')).toContainText(elsewhere)
  await expect(welcome.getByTestId('welcome-folder-stems').getByTestId('free-space')).toBeVisible()

  await welcome.getByRole('button', { name: 'Continue' }).click()
  await expect(welcome.getByRole('heading', { name: 'How should stems be saved?' })).toBeVisible()
  await welcome.getByText('FLAC 24-bit').click()
  await expect(welcome.getByRole('radio', { name: /FLAC/ })).toBeChecked()
  await welcome.getByRole('switch', { name: 'Start songs as soon as they are added' }).click()

  await welcome.getByRole('button', { name: 'Continue' }).click()
  // Every model is in the FakeEngine's folder already: nothing to download.
  await expect(welcome.getByRole('heading', { name: 'You are ready' })).toBeVisible()
  await welcome.getByRole('button', { name: 'Done' }).click()
  await expect(welcome).toBeHidden()

  // The same settings as in Settings, and the format where files are dropped.
  await expect(page.getByRole('combobox', { name: 'Output format' })).toContainText('FLAC')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText(elsewhere)).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Start songs automatically' })).toBeChecked()
})

test('the welcome can be skipped, and the folders stay as they were', async () => {
  ctx = await launch({ OPENSTEMS_E2E_WELCOME: '1' })
  const { page, outputDir } = ctx
  const welcome = page.getByTestId('welcome')
  await expect(welcome.getByTestId('welcome-folder-stems')).toContainText(outputDir)
  await welcome.getByRole('button', { name: 'Skip' }).click()
  await expect(welcome).toBeHidden()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText(outputDir)).toBeVisible()

  // Settings can walk through it again, from the first step.
  await page.getByRole('button', { name: 'Show the welcome again' }).click()
  await expect(welcome.getByRole('heading', { name: 'Where should your files go?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(welcome).toBeHidden()
})
