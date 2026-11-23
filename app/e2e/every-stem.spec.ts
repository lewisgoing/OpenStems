import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { type Launched, lastDrag, launch } from './helpers'

// The every-stem recipe: thirteen stems in groups, each group soloed, muted and dragged as one.
// EVERY_STEM_SHOT=<file> also saves a picture of the panel for design review.

let ctx: Launched

test.beforeEach(async () => {
  ctx = await launch()
})

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
})

test('every stem: thirteen files in groups that solo and drag as one', async () => {
  const { page } = ctx
  await page.getByRole('combobox', { name: 'Recipe' }).click()
  const option = page.getByRole('option', { name: /Every stem/ })
  await expect(option).toContainText('13 stems: vocals (2), drums (7), bass, melody (3)')
  await option.click()
  await page.getByTestId('file-input').setInputFiles([join(ctx.fixtures, 'First Song.mp3')])

  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toContainText('13 stems')
  const folder = join(ctx.outputDir, 'First Song', 'every-stem')
  expect(readdirSync(folder).filter((f) => f.endsWith('.wav'))).toHaveLength(13)

  await done.click()
  const panel = page.getByRole('complementary', { name: 'Stems' })
  await expect(panel.getByTestId('stem-row')).toHaveCount(13)
  await expect(panel.getByTestId('stem-group')).toHaveCount(3)

  // The heading solos the whole kit, and what is heard is called by the group's name.
  await panel.getByRole('button', { name: 'Solo drums' }).click()
  await expect(panel.getByRole('button', { name: 'Solo other drums' })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('button', { name: 'Solo bass' })).toHaveAttribute('aria-pressed', 'false')
  await expect(panel.getByTestId('drag-mix')).toHaveAccessibleName('Drag the mix: Drums')

  if (process.env.EVERY_STEM_SHOT) await page.screenshot({ path: process.env.EVERY_STEM_SHOT })

  // The heading's handle drags the kit out as one real file, written when the pointer comes near.
  const handle = panel.getByRole('button', { name: 'Drag the drums as one file' })
  await handle.hover()
  await expect(handle).toHaveAttribute('data-path', /drums\.wav$/)
  await handle.dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const [kit] = (await lastDrag(ctx.app)) ?? []
  expect(basename(kit ?? '')).toBe('First Song - drums.wav')
  expect(existsSync(kit ?? '')).toBe(true)

  // Every stem is still one drag: thirteen files, and no group written twice among them.
  await panel.getByTestId('drag-all').dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(13)
})
