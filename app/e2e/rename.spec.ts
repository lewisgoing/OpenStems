import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, launch } from './helpers'

// A song's name can be typed over its file's: on a song that waits in the queue, and on stems
// that are already written, where the stem folder and its files are renamed with it. Manual
// start is on here, so a song waits long enough to be named.
let ctx: Launched

test.beforeEach(async () => {
  ctx = await launch({ OPENSTEMS_AUTO_START: '', OPENSTEMS_FAKE_DELAY: '0.02' })
})

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

const manifest = (folder: string) =>
  JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { source: { name: string; path: string }; stems: { file: string }[] }

/**
 * The name in a stem folder's manifest, or null while there is none to read. The manifest is
 * the last thing a rename writes, after the folder and the files: once it has the new name,
 * the rename is done.
 */
const nameIn = (folder: string) => {
  try {
    return manifest(folder).source.name
  } catch {
    return null
  }
}

test('rename: a waiting song from its menu, then its stems on the disk from the panel and the history', async () => {
  const page = ctx.page
  const original = join(ctx.fixtures, 'First Song.mp3')
  await page.getByTestId('file-input').setInputFiles([original])
  const row = page.getByTestId('job-row')
  await expect(row).toHaveAttribute('data-state', 'queued')

  // Before: Rename in the row's menu turns the title into a field, where the title was.
  const title = row.getByTestId('drag-source')
  const titleBox = await title.boundingBox()
  const rowBox = await row.boundingBox()
  await row.click({ button: 'right' })
  await page.getByTestId('row-menu').getByRole('menuitem', { name: 'Rename' }).click()
  const field = row.getByLabel('Song name')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('First Song')
  // The menu is gone and the field is still there: the closing menu did not take the focus.
  await expect(page.getByTestId('row-menu')).toBeHidden()
  await expect(field).toBeFocused()
  // Nothing moved: the words are where they were, and the row is as tall as it was.
  const fieldBox = await field.boundingBox()
  const padding = await field.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft))
  expect(Math.abs((fieldBox?.x ?? 0) + padding - (titleBox?.x ?? 0))).toBeLessThan(1)
  expect(Math.abs(((await row.boundingBox())?.height ?? 0) - (rowBox?.height ?? 0))).toBeLessThan(0.5)

  // The name is selected whole, so typing replaces it.
  await page.keyboard.type('Night Drive')
  await page.keyboard.press('Enter')
  await expect(field).toHaveCount(0)
  await expect(row.getByTestId('drag-source')).toHaveText('Night Drive')
  // A double click on a waiting song's title opens the field too; Escape puts back what was there.
  await row.getByTestId('drag-source').dblclick()
  await expect(row.getByLabel('Song name')).toBeFocused()
  await page.keyboard.type('Nope')
  await page.keyboard.press('Escape')
  await expect(row.getByLabel('Song name')).toHaveCount(0)
  await expect(row.getByTestId('drag-source')).toHaveText('Night Drive')

  await page.getByRole('button', { name: 'Start 1 song' }).click()
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toHaveCount(1)
  const first = join(ctx.outputDir, 'Night Drive', 'full-song')
  expect(manifest(first).source.name).toBe('Night Drive')
  expect(manifest(first).stems.every((stem) => stem.file.startsWith('Night Drive - '))).toBe(true)
  expect(existsSync(join(ctx.outputDir, 'First Song'))).toBe(false)

  // After: the pencil beside the panel's title. The folder and the stems are renamed, with a
  // character a file name cannot hold kept in the name and replaced on the disk.
  await done.click()
  const panel = page.getByLabel('Stems')
  await expect(panel.getByRole('heading')).toHaveText('Night Drive')
  await panel.getByRole('heading').hover()
  await panel.getByRole('button', { name: 'Rename' }).click()
  await expect(panel.getByLabel('Song name')).toBeFocused()
  await page.keyboard.type('Dusk: Live')
  await page.keyboard.press('Enter')
  const second = join(ctx.outputDir, 'Dusk_ Live', 'full-song')
  await expect.poll(() => nameIn(second)).toBe('Dusk: Live')
  expect(existsSync(join(ctx.outputDir, 'Night Drive'))).toBe(false)
  const after = manifest(second)
  expect(after.source.name).toBe('Dusk: Live')
  for (const stem of after.stems) {
    expect(stem.file.startsWith('Dusk_ Live - ')).toBe(true)
    expect(existsSync(join(second, stem.file))).toBe(true)
  }
  expect(readdirSync(second).some((name) => name.includes('Night Drive'))).toBe(false)
  await expect(panel.getByRole('heading')).toHaveText('Dusk: Live')
  await expect(done.getByTestId('drag-source')).toHaveText('Dusk: Live')
  // With its stems open the row stays where it is, so a double click on its title renames too.
  await done.getByTestId('drag-source').dblclick()
  await expect(done.getByLabel('Song name')).toBeFocused()
  await page.keyboard.press('Escape')
  // The renamed stems are the ones dragged out, and they still play.
  // By folder and file, not the whole path: a Mac's temp folder has two spellings.
  const dragged = async () =>
    (JSON.parse((await panel.getByTestId('drag-all').getAttribute('data-paths')) ?? '[]') as string[]).map((path) => path.split(/[\\/]/).slice(-3).join('/'))
  await expect.poll(dragged).toEqual(after.stems.map((stem) => `Dusk_ Live/full-song/${stem.file}`))
  await expect(panel.getByRole('button', { name: /^(Play|Pause)$/ }).first()).toBeEnabled()
  await panel.getByRole('button', { name: 'Play' }).click()
  await expect(panel.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  // The song's own file keeps its name.
  expect(existsSync(original)).toBe(true)
  expect(after.source.path.endsWith('First Song.mp3')).toBe(true)

  // F2 renames the song whose stems are shown, as it does a file. They are playing: the app's
  // own player holds none of the files, so the folder can still be renamed under it.
  await page.keyboard.press('F2')
  await expect(panel.getByLabel('Song name')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel.getByRole('heading')).toHaveText('Dusk: Live')
  await page.keyboard.press('F2')
  await page.keyboard.type('Dawn')
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('heading')).toHaveText('Dawn')
  const dawn = join(ctx.outputDir, 'Dawn', 'full-song')
  await expect.poll(() => nameIn(dawn)).toBe('Dawn')
  expect(existsSync(join(ctx.outputDir, 'Dusk_ Live'))).toBe(false)
  await expect(page.getByRole('alert')).toHaveCount(0)

  // History has the new name. A click opens the song's stems, and then a double click on its
  // title there renames too. Emptied, the song goes by the name of its file again, on the
  // disk as well.
  // In the smallest window, where the stems panel leaves the list least room: the title is
  // still there to read and to double-click.
  await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible())?.setSize(980, 700))
  await page.getByRole('button', { name: 'History' }).click()
  const past = page.getByTestId('history-row')
  await expect(past).toHaveCount(1)
  await expect(past.getByTestId('drag-source')).toHaveText('Dawn')
  await past.click()
  await expect(past.getByTestId('drag-source')).toBeVisible()
  await expect(page.getByLabel('Stems').getByRole('heading')).toHaveText('Dawn')
  await past.getByTestId('drag-source').dblclick()
  const pastField = past.getByLabel('Song name')
  await expect(pastField).toHaveValue('Dawn')
  await pastField.fill('')
  await expect(pastField).toHaveAttribute('placeholder', 'First Song')
  await pastField.press('Enter')
  await expect(past.getByTestId('drag-source')).toHaveText('First Song')
  const third = join(ctx.outputDir, 'First Song', 'full-song')
  await expect.poll(() => nameIn(third)).toBe('First Song')
  expect(existsSync(join(ctx.outputDir, 'Dawn'))).toBe(false)
  expect(manifest(third).stems.every((stem) => stem.file.startsWith('First Song - '))).toBe(true)
  // The panel that showed the song follows it to where its stems are now.
  await expect(page.getByLabel('Stems').getByRole('heading')).toHaveText('First Song')
  await expect(page.getByLabel('Stems').getByRole('button', { name: /^(Play|Pause)$/ }).first()).toBeEnabled()
})

test('rename: a name that is taken is refused, and the song keeps the one it has', async () => {
  const page = ctx.page
  await page.getByTestId('file-input').setInputFiles(['First Song.mp3', 'Second Song.flac'].map((name) => join(ctx.fixtures, name)))
  await page.getByRole('button', { name: 'Start 2 songs' }).click()
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toHaveCount(2)

  // A finished row opens its stems on a click, which moves the list: there the menu renames.
  await done.filter({ hasText: 'Second Song' }).click({ button: 'right' })
  await page.getByTestId('row-menu').getByRole('menuitem', { name: 'Rename' }).click()
  const field = page.getByRole('list', { name: 'Jobs' }).getByLabel('Song name')
  await expect(field).toBeFocused()
  await page.keyboard.type('First Song')
  await expect(field).toHaveValue('First Song')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toHaveText('there is already a song called "First Song" in the output folder')
  await expect(done.getByRole('button', { name: 'Drag the original file of Second Song' })).toBeVisible()
  expect(existsSync(join(ctx.outputDir, 'Second Song', 'full-song', 'manifest.json'))).toBe(true)
})

test('rename: the longest name stays inside its row, as a field and as a title', async () => {
  const page = ctx.page
  await page.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])
  const row = page.getByTestId('job-row')
  await expect(row).toHaveAttribute('data-state', 'queued')
  const inside = async (box: { x: number; width: number } | null) => {
    const outer = await row.boundingBox()
    return Boolean(box && outer && box.x >= outer.x && box.x + box.width <= outer.x + outer.width)
  }
  const height = (await row.boundingBox())?.height ?? 0

  await row.getByTestId('drag-source').dblclick()
  const field = row.getByLabel('Song name')
  const long = 'A very long name for a song that somebody pasted from a web page '.repeat(2).trim().slice(0, 120)
  await field.fill(long)
  expect(await inside(await field.boundingBox())).toBe(true)
  expect(Math.abs(((await row.boundingBox())?.height ?? 0) - height)).toBeLessThan(0.5)
  // The row's own controls are still there to use.
  await expect(row.getByRole('button', { name: 'Cancel' })).toBeAttached()
  await field.press('Enter')
  const title = row.getByTestId('drag-source')
  await expect(title).toHaveText(long)
  expect(await inside(await title.boundingBox())).toBe(true)
  expect(Math.abs(((await row.boundingBox())?.height ?? 0) - height)).toBeLessThan(0.5)
  // One character more is refused in the app's own words, and the song keeps its name.
  await title.dblclick()
  await row.getByLabel('Song name').fill(`${long}x`)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert')).toHaveText('A name can be up to 120 characters.')
  await expect(row.getByTestId('drag-source')).toHaveText(long)
})
