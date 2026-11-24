import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { type Page, expect, test } from '@playwright/test'
import { type Launched, MOD, lastDrag, launch } from './helpers'

// The trimmer (docs/adr/0023-trimmer.md) on the FakeEngine: a part of a song or of its stems,
// on a grid fixed by hand, dragged out as real WAV files of the part's length. The fixture
// songs are two seconds of tones: the grid is typed, so the bars and beats are known.

test.describe.configure({ timeout: 240_000 })

let ctx: Launched
let errors: string[] = []

test.afterEach(async () => {
  await ctx.app.close().catch(() => undefined)
  // The page threw nothing along the way.
  expect(errors).toEqual([])
})

async function start(env: Record<string, string> = {}) {
  ctx = await launch(env)
  errors = []
  ctx.page.on('pageerror', (error) => errors.push(error.message))
}

const add = (...names: string[]) => ctx.page.getByTestId('file-input').setInputFiles(names.map((name) => join(ctx.fixtures, name)))
const editor = () => ctx.page.getByTestId('trim-editor')
const handle = () => ctx.page.getByTestId('clip-handle')

/** Forget the last drag-out, so the next one is known to be new. */
const forgetDrag = () =>
  ctx.app.evaluate(() => {
    ;(globalThis as unknown as { __openstemsE2E: { lastDrag: string[] | null } }).__openstemsE2E.lastDrag = null
  })

/** The trimmer has read the song: its length is known and a waveform is drawn. */
async function opened() {
  // The first look at a song's own file decodes it and finds its grid: seconds the first time.
  await expect(ctx.page.getByTestId('trim-loading')).toHaveCount(0, { timeout: 120_000 })
  await expect(editor()).toHaveAttribute('data-wave', /^(peaks|audio)$/, { timeout: 60_000 })
}

/** Where `t` (seconds of the song) is on screen in an element that shows the editor's view. */
async function xOf(testId: string, t: number): Promise<{ x: number; y: number; height: number }> {
  const t0 = Number(await editor().getAttribute('data-t0'))
  const t1 = Number(await editor().getAttribute('data-t1'))
  const box = await ctx.page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`${testId} is not on screen`)
  return { x: box.x + ((t - t0) / (t1 - t0)) * box.width, y: box.y, height: box.height }
}

/** A drag across the waveform from one point of the song to another. */
async function select(from: number, to: number) {
  const a = await xOf('trim-wave', from)
  const b = await xOf('trim-wave', to)
  const y = a.y + a.height / 2
  await ctx.page.mouse.move(a.x, y)
  await ctx.page.mouse.down()
  await ctx.page.mouse.move((a.x + b.x) / 2, y, { steps: 5 })
  await ctx.page.mouse.move(b.x, y, { steps: 5 })
  await ctx.page.mouse.up()
}

/** The part chosen, as the editor holds it. */
async function selection(): Promise<{ start: number; end: number }> {
  const [start, end] = ((await editor().getAttribute('data-sel')) ?? '').split(',').map(Number)
  if (start === undefined || end === undefined || !(end > start)) throw new Error('no part is chosen')
  return { start, end }
}

async function typeInto(testId: string, text: string) {
  const field = ctx.page.getByTestId(testId)
  await field.fill(text)
  await field.press('Enter')
}

const snapTo = (name: string) => ctx.page.getByRole('radiogroup', { name: 'Snap' }).getByRole('radio', { name, exact: true }).click()

/** Frames and rate of a WAV file, from its chunks: clips carry a LIST chunk, floats a fact chunk. */
function wav(path: string): { frames: number; rate: number } {
  const bytes = readFileSync(path)
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path} is not a WAV file`)
  let rate = 0
  let blockAlign = 0
  let data = -1
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    if (id === 'fmt ') {
      rate = bytes.readUInt32LE(at + 12)
      blockAlign = bytes.readUInt16LE(at + 20)
    } else if (id === 'data') {
      data = size
    }
    at += 8 + size + (size % 2)
  }
  if (data < 0 || blockAlign === 0) throw new Error(`${path} has no audio`)
  return { frames: data / blockAlign, rate }
}

/** The loudest sample in each half of a WAV file: 16 or 24-bit, or float. */
function halves(path: string): [number, number] {
  const bytes = readFileSync(path)
  let format = 0
  let channels = 0
  let bits = 0
  let start = -1
  let size = 0
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = bytes.toString('ascii', at, at + 4)
    const length = bytes.readUInt32LE(at + 4)
    if (id === 'fmt ') {
      format = bytes.readUInt16LE(at + 8)
      channels = bytes.readUInt16LE(at + 10)
      bits = bytes.readUInt16LE(at + 22)
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of its sub-format.
      if (format === 0xfffe) format = bytes.readUInt16LE(at + 32)
    } else if (id === 'data') {
      start = at + 8
      size = length
    }
    at += 8 + length + (length % 2)
  }
  const width = bits / 8
  const frames = size / (width * channels)
  const sample = (frame: number, channel: number): number => {
    const at = start + (frame * channels + channel) * width
    if (format === 3) return bytes.readFloatLE(at)
    return width === 3 ? bytes.readIntLE(at, 3) / 2 ** 23 : bytes.readInt16LE(at) / 2 ** 15
  }
  const loudest = (from: number, to: number) => {
    let peak = 0
    for (let frame = from; frame < to; frame++) for (let c = 0; c < channels; c++) peak = Math.max(peak, Math.abs(sample(frame, c)))
    return peak
  }
  const middle = Math.floor(frames / 2)
  return [loudest(0, middle), loudest(middle, frames)]
}

/** A file is as long as the part, to the frame (the engine rounds as JavaScript may not). */
function expectLength(path: string, part: { start: number; end: number }) {
  const { frames, rate } = wav(path)
  expect(rate).toBe(44100)
  expect(Math.abs(frames - Math.round((part.end - part.start) * rate))).toBeLessThanOrEqual(1)
}

/** The songs in the queue, as the engine has them. */
const jobsNow = (page: Page) =>
  page.evaluate(async () => {
    const status = await window.openstems.engine()
    if (status.state !== 'ready') throw new Error('the engine is not ready')
    const response = await fetch(`${status.baseUrl}/v1/jobs`, { headers: { Authorization: `Bearer ${status.token}` } })
    return ((await response.json()) as { jobs: { track_name: string; options: Record<string, unknown> }[] }).jobs
  })

const manifest = (folder: string) => JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { analysis: { bpm: number | null; downbeat?: number | null } }

/** Ask the engine directly, as the app would. */
const engineCall = (page: Page, path: string, method = 'GET', body?: unknown) =>
  page.evaluate(
    async ({ path, method, body }) => {
      const status = await window.openstems.engine()
      if (status.state !== 'ready') throw new Error('the engine is not ready')
      const response = await fetch(`${status.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${status.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return (await response.json()) as unknown
    },
    { path, method, body },
  )

test('a finished song: the grid fixed by hand, a part of a stem, of every stem and of a mix dragged out', async () => {
  await start()
  const { page } = ctx
  await add('First Song.mp3')
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toHaveCount(1)
  const folder = join(ctx.outputDir, 'First Song', 'full-song')

  await done.getByTestId('row-trim').click()
  await opened()
  await expect(editor()).not.toHaveAttribute('data-waiting', 'true')
  // The song's own file first; its stems beside it.
  await expect(editor()).toHaveAttribute('data-target', 'Original')
  await expect(page.locator('[data-chip^="stem:"]')).toHaveCount(6)

  // The grid: a typed tempo is the song's, saved as the tempo field saves it.
  await typeInto('tempo-field', '120')
  await expect(editor()).toHaveAttribute('data-bpm', '120')
  await expect(page.getByTestId('tempo-was')).toHaveText(/^was \d/)
  await expect.poll(() => manifest(folder).analysis.bpm).toBe(120)

  // Bar 1's flag dragged along the ruler, then put exactly where it belongs.
  const flagFrom = Number(await editor().getAttribute('data-downbeat'))
  const from = await xOf('trim-ruler', flagFrom)
  const to = await xOf('trim-ruler', 0.25)
  await page.mouse.move(from.x, from.y + from.height - 6)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, from.y + from.height - 6, { steps: 4 })
  await page.mouse.move(to.x, from.y + from.height - 6, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => Number(await editor().getAttribute('data-downbeat'))).toBeCloseTo(0.25, 1)
  const dragged = Number(await editor().getAttribute('data-downbeat'))
  await expect.poll(() => manifest(folder).analysis.downbeat).toBe(Math.round(dragged * 10000) / 10000)
  // Typed as the field reads it, though bar 1 was a fraction of a millisecond off it.
  await typeInto('downbeat-field', '0:00.250')
  await expect(editor()).toHaveAttribute('data-downbeat', '0.25')
  await expect.poll(() => manifest(folder).analysis.downbeat).toBe(0.25)

  // A part of the drums, on the beats: beats 2 to 4 of bar 1.
  await page.locator('[data-chip="stem:drums"]').click()
  await expect(editor()).toHaveAttribute('data-target', 'drums')
  await snapTo('Beat')
  await select(0.8, 1.7)
  await expect(page.getByTestId('readout')).toContainText('1.2 to 1.4 · 2 beats · 1.00 s')
  const part = await selection()
  expect(part.start).toBeCloseTo(0.75, 6)
  expect(part.end).toBeCloseTo(1.75, 6)

  await expect(handle()).toHaveAttribute('data-state', 'ready')
  await expect(page.getByTestId('clip-name')).toHaveText('First Song - drums - 1.2-1.4.wav')
  await forgetDrag()
  await handle().dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const [clip = ''] = (await lastDrag(ctx.app)) ?? []
  expect(basename(clip)).toBe('First Song - drums - 1.2-1.4.wav')
  // Beside the stems, in their Clips folder.
  expect(basename(dirname(clip))).toBe('Clips')
  expect(basename(dirname(dirname(clip)))).toBe('full-song')
  expect(existsSync(clip)).toBe(true)
  expectLength(clip, part)
  await expect(page.getByTestId('trim-foot')).toContainText(dirname(clip))

  // Every stem, this part: one file per stem, written once the pointer reaches it.
  const all = page.getByTestId('all-handle')
  await expect(all).toContainText('Every stem, this part')
  await all.hover()
  await expect(all).toHaveAttribute('data-state', 'ready')
  await forgetDrag()
  await all.dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(6)
  const each = (await lastDrag(ctx.app)) ?? []
  expect(each.map((path) => basename(path)).sort()).toEqual(
    ['bass', 'drums', 'guitar', 'other', 'piano', 'vocals'].map((stem) => `First Song - ${stem} - 1.2-1.4.wav`),
  )
  for (const path of each) {
    expect(dirname(path)).toBe(dirname(clip))
    expect(existsSync(path)).toBe(true)
    expectLength(path, part)
  }

  // Ctrl+click (Cmd on a Mac) adds a stem: the two are one file.
  await page.locator('[data-chip="stem:bass"]').click({ modifiers: [MOD] })
  await expect(page.locator('[data-chip="stem:drums"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-chip="stem:bass"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(editor()).toHaveAttribute('data-target', 'Drums + bass')
  await expect(handle()).toHaveAttribute('data-state', 'ready')
  await forgetDrag()
  await handle().dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const [mix = ''] = (await lastDrag(ctx.app)) ?? []
  expect(basename(mix)).toBe('First Song - drums + bass - 1.2-1.4.wav')
  expect(dirname(mix)).toBe(dirname(clip))
  expectLength(mix, part)

  // Back where it came from.
  await page.getByTestId('trim-back').click()
  await expect(editor()).toHaveCount(0)
  await expect(done).toBeVisible()
})

test('a waiting song: its own file is read and clipped, and its tempo is the one in its row', async () => {
  // Manual start: the song waits in the queue.
  await start({ OPENSTEMS_AUTO_START: '' })
  const { page } = ctx
  await add('Second Song.flac')
  const row = page.getByTestId('job-row')
  await expect(row).toHaveAttribute('data-state', 'queued')
  await expect(row.getByLabel('Tempo in BPM')).toHaveValue('')

  await row.getByTestId('row-trim').click()
  await expect(editor()).toHaveAttribute('data-waiting', 'true')
  await opened()
  expect(Number(await editor().getAttribute('data-duration'))).toBeCloseTo(2, 1)
  // Only the song itself, until it is separated.
  await expect(page.locator('[data-chip]')).toHaveCount(1)
  await expect(page.locator('[data-chip="original"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('Single stems can be trimmed once it is separated.')).toBeVisible()

  // A tempo and bar 1 by hand: bars of one second.
  await typeInto('tempo-field', '240')
  await expect(editor()).toHaveAttribute('data-bpm', '240')
  await typeInto('downbeat-field', '0')
  await expect(editor()).toHaveAttribute('data-downbeat', '0')
  await snapTo('Bar')
  await select(0.15, 0.85)
  await expect(page.getByTestId('readout')).toContainText('Bar 1 · 1 bar · 1.00 s')
  const part = await selection()

  // A clip of the song's own file, beside its stem folders.
  await expect(handle()).toHaveAttribute('data-state', 'ready')
  await forgetDrag()
  await handle().dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const [clip = ''] = (await lastDrag(ctx.app)) ?? []
  expect(basename(clip)).toBe('Second Song - bar 1.wav')
  expect(basename(dirname(clip))).toBe('Clips')
  expect(basename(dirname(dirname(clip)))).toBe('Second Song')
  expect(existsSync(clip)).toBe(true)
  expectLength(clip, part)

  // The setting is off: the part says nothing of what Start does, and the job carries none.
  await expect(page.getByTestId('start-part')).toHaveCount(0)
  await page.getByTestId('trim-back').click()
  await expect(editor()).toHaveCount(0)
  // One tempo per song: the row shows the tempo the trimmer set.
  await expect(row.getByLabel('Tempo in BPM')).toHaveValue('240')
  await expect(row.getByTestId('job-status')).toHaveText('Ready to start')
  const [job] = await jobsNow(page)
  expect(job?.options.bpm).toBe(240)
  expect(job?.options.downbeat).toBe(0)
  expect(job?.options.range ?? null).toBeNull()
})

test('with "Separate only the trimmed part" on, Start separates just the part chosen', async () => {
  await start({ OPENSTEMS_AUTO_START: '' })
  const { page } = ctx
  await page.getByRole('button', { name: 'Settings' }).click()
  const setting = page.getByRole('switch', { name: 'Separate only the trimmed part' })
  await expect(setting).not.toBeChecked()
  await setting.click()
  await expect(setting).toBeChecked()
  await page.getByRole('button', { name: 'Queue' }).click()

  await add('First Song.mp3')
  const row = page.getByTestId('job-row')
  await expect(row).toHaveAttribute('data-state', 'queued')
  await row.getByTestId('row-trim').click()
  await opened()
  await typeInto('tempo-field', '240')
  await expect(editor()).toHaveAttribute('data-bpm', '240')
  await typeInto('downbeat-field', '0')
  await expect(editor()).toHaveAttribute('data-downbeat', '0')
  await snapTo('Bar')
  await select(0.15, 0.85)
  // The footer says what Start will do, once the song carries the part.
  await expect(page.getByTestId('start-part')).toHaveText('Start separates only bar 1.')

  await page.getByTestId('trim-back').click()
  await expect(editor()).toHaveCount(0)
  await expect(row.getByTestId('job-status')).toHaveText('Ready to start, bar 1 only')
  const [job] = await jobsNow(page)
  const range = job?.options.range as { start: number; end: number; label: string }
  expect(range).toEqual({ start: 0, end: 1, label: 'bar 1' })

  await page.getByRole('button', { name: 'Start 1 song' }).click()
  await expect(page.locator('[data-testid="job-row"][data-state="done"]')).toHaveCount(1)
  // A song of its own, named by its part; the whole song was not separated.
  const folder = join(ctx.outputDir, 'First Song (bar 1)', 'full-song')
  const stems = readdirSync(folder).filter((name) => name.endsWith('.wav'))
  expect(stems).toHaveLength(6)
  for (const name of stems) {
    expect(name.startsWith('First Song (bar 1) - ')).toBe(true)
    expectLength(join(folder, name), range)
  }
  expect(existsSync(join(ctx.outputDir, 'First Song', 'full-song'))).toBe(false)
})

test("the stems panel's Trim opens the trimmer on what solo and mute leave audible", async () => {
  await start()
  const { page } = ctx
  await add('First Song.mp3')
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await done.click()
  const panel = page.getByRole('complementary', { name: 'Stems' })
  await expect(panel.getByTestId('stem-row')).toHaveCount(6)
  await panel.getByRole('button', { name: 'Solo drums' }).click()
  await panel.getByRole('button', { name: 'Mute vocals' }).click()

  await panel.getByTestId('panel-trim').click()
  await expect(editor()).toHaveAttribute('data-target', 'drums')
  await expect(page.locator('[data-chip="stem:drums"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-chip="original"]')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('[data-chip="stem:vocals"]')).toHaveAttribute('aria-pressed', 'false')
  await opened()

  // Back, solo and mute are as they were.
  await page.getByTestId('trim-back').click()
  await expect(editor()).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Solo drums' })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.getByRole('button', { name: 'Mute vocals' })).toHaveAttribute('aria-pressed', 'true')
})

test("a stem that enters late is cut on the song's timeline: silent until it starts", async () => {
  // The FakeEngine leaves the vocals silent for their first second. With Trim silence on, that
  // silence is cut off their file, which then begins a second into the song (its start).
  await start({ OPENSTEMS_FAKE_LATE: 'vocals:1' })
  const { page } = ctx
  await engineCall(page, '/v1/settings', 'PATCH', { trim_silence: true })
  await add('First Song.mp3')
  const done = page.locator('[data-testid="job-row"][data-state="done"]')
  await expect(done).toHaveCount(1)
  const { jobs } = (await engineCall(page, '/v1/jobs')) as { jobs: { stems: { name: string; start: number }[] }[] }
  const starts = Object.fromEntries((jobs[0]?.stems ?? []).map((stem) => [stem.name, stem.start]))
  expect(starts.vocals).toBeCloseTo(1, 3)
  expect(starts.drums).toBeCloseTo(0, 3)

  await done.getByTestId('row-trim').click()
  await opened()
  // Still the whole song, two seconds, with the vocals placed a second into it.
  expect(Number(await editor().getAttribute('data-duration'))).toBeCloseTo(2, 1)
  await page.locator('[data-chip="stem:vocals"]').click()
  await expect(editor()).toHaveAttribute('data-target', 'vocals')
  await typeInto('tempo-field', '240')
  await expect(editor()).toHaveAttribute('data-bpm', '240')
  await typeInto('downbeat-field', '0')
  await expect(editor()).toHaveAttribute('data-downbeat', '0')
  await snapTo('Beat')
  // Beats 1.3 to 2.3: half a second before the vocals come in, half a second after.
  await select(0.55, 1.45)
  const part = await selection()
  expect(part.start).toBeCloseTo(0.5, 6)
  expect(part.end).toBeCloseTo(1.5, 6)

  await expect(handle()).toHaveAttribute('data-state', 'ready')
  await forgetDrag()
  await handle().dispatchEvent('dragstart')
  await expect.poll(() => lastDrag(ctx.app)).toHaveLength(1)
  const [clip = ''] = (await lastDrag(ctx.app)) ?? []
  expect(basename(clip)).toBe('First Song - vocals - 1.3-2.3.wav')
  expectLength(clip, part)
  const [before, after] = halves(clip)
  expect(before).toBe(0)
  expect(after).toBeGreaterThan(0.001)
})
