import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@playwright/test'
import { MAC, MOD, captureAroundPopup, clickTray, launch, trayPage } from './helpers'

// Design review screenshots. Run with: SHOTS=1 pnpm e2e -g screenshots
// The file names are the same on Windows and on a Mac: give each system its own SHOTS_DIR.
test.skip(process.env.SHOTS !== '1', 'set SHOTS=1 to capture screenshots')

/** The main views, dark (the default) or, picked with the sidebar's switch, light. */
async function mainViews(theme: 'dark' | 'light') {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page, fixtures } = await launch({ OPENSTEMS_FAKE_DELAY: '0.15' })
  const prefix = theme === 'light' ? 'light-' : ''
  const shot = (name: string) => page.screenshot({ path: join(out, `${prefix}${name}.png`) })
  try {
    if (theme === 'light') {
      await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' }).click()
      await page.waitForTimeout(300)
    }
    await shot('1-empty')
    await page.getByTestId('file-input').setInputFiles(
      ['First Song.mp3', 'Second Song.flac', 'Video Clip.mp4'].map((n) => join(fixtures, n)),
    )
    await page.locator('[data-testid="job-row"][data-state="running"]').first().waitFor()
    await page.waitForTimeout(600)
    await shot('2-queue-running')
    await page.locator('[data-testid="job-row"][data-state="done"]').nth(2).waitFor()
    await page.locator('[data-testid="job-row"][data-state="done"]').first().click()
    await page.getByTestId('stem-row').nth(5).waitFor()
    await page.waitForTimeout(700)
    await shot('3-stems')
    // The menu a right-click opens on a finished song.
    await page.locator('[data-testid="job-row"][data-state="done"]').first().click({ button: 'right' })
    await page.waitForTimeout(300)
    await shot('3b-row-menu')
    await page.keyboard.press('Escape')
    await page.getByRole('combobox', { name: 'Recipe' }).click()
    await page.waitForTimeout(400)
    await shot('4-recipes')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(500)
    await shot('5-history')
    await page.getByRole('button', { name: 'Models' }).click()
    await page.waitForTimeout(500)
    await shot('6-models')
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.waitForTimeout(500)
    await shot('7-settings')
    if (theme === 'light') {
      // The quick-drop window follows the pick, with the stems of the last song.
      await clickTray(app)
      const popup = await trayPage(app)
      await popup.waitForTimeout(600)
      await popup.screenshot({ path: join(out, `${prefix}tray.png`) })
    }
  } finally {
    await app.close()
  }
}

test('screenshots', async () => {
  await mainViews('dark')
})

test('screenshots in light', async () => {
  await mainViews('light')
})

/** The welcome's three steps, dark and light. */
test('screenshots of the welcome', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page } = await launch({ OPENSTEMS_E2E_WELCOME: '1' })
  const welcome = page.getByTestId('welcome')
  // What a real first start has: no models yet. The FakeEngine has them all, so the list is
  // read as if none were there; the change of format below makes the app read it again.
  await page.route(/\/v1\/models$/, async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { models: { status: string }[] }
    for (const model of body.models) model.status = 'missing'
    await route.fulfill({ response, json: body })
  })
  try {
    for (const theme of ['dark', 'light'] as const) {
      const prefix = theme === 'light' ? 'light-' : ''
      if (theme === 'light') {
        await page.evaluate(() => window.openstems.setShell({ theme: 'light' }))
        await page.waitForTimeout(300)
      }
      await welcome.getByTestId('free-space').first().waitFor()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(out, `${prefix}welcome-1-folders.png`) })
      await welcome.getByRole('button', { name: 'Continue' }).click()
      await page.waitForTimeout(400)
      await welcome.getByText('WAV 24-bit').click()
      await welcome.getByText('WAV 32-bit float').click()
      await page.screenshot({ path: join(out, `${prefix}welcome-2-format.png`) })
      await welcome.getByRole('button', { name: 'Continue' }).click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(out, `${prefix}welcome-3-models.png`) })
      await welcome.getByRole('button', { name: 'Back' }).click()
      await welcome.getByRole('button', { name: 'Back' }).click()
    }
  } finally {
    await app.close()
  }
})

test('screenshots of the quick-drop window', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, fixtures } = await launch({ OPENSTEMS_FAKE_DELAY: '0.25' })
  const page = await trayPage(app)
  const shot = (name: string) => page.screenshot({ path: join(out, `${name}.png`) })
  try {
    await clickTray(app)
    await page.getByRole('heading', { name: 'Drop a song here' }).waitFor()
    await page.waitForTimeout(400)
    await shot('tray-1-empty')

    // A file dragged over the window.
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.items.add(new File([''], 'song.mp3'))
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data }))
    })
    await page.waitForTimeout(400)
    await shot('tray-2-drag-over')
    await page.evaluate(() => {
      const data = new DataTransfer()
      data.items.add(new File([''], 'song.mp3'))
      window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: data }))
    })

    await page.getByTestId('file-input').setInputFiles(
      ['First Song.mp3', 'Second Song.flac', 'Video Clip.mp4'].map((n) => join(fixtures, n)),
    )
    await page.locator('[data-testid="quick-row"][data-state="running"]').first().waitFor()
    await page.waitForTimeout(500)
    await shot('tray-3-running')
    await page.locator('[data-testid="quick-row"][data-state="done"]').nth(2).waitFor()
    await page.waitForTimeout(700)
    await shot('tray-4-done')
    await page.locator('[data-testid="quick-row"][data-state="done"]').first().click({ button: 'right' })
    await page.waitForTimeout(300)
    await shot('tray-4b-row-menu')
    await page.keyboard.press('Escape')
    // The real screen: frame, shadow and where the window sits by the taskbar or under the
    // menu bar. A Mac lets an app see the screen only with the screen recording permission:
    // without it this one picture is left out and the rest go on.
    await captureAroundPopup(app, join(out, 'tray-on-screen.png')).catch((error: unknown) => {
      if (!MAC) throw error
      console.log(`tray-on-screen.png was not captured: ${String(error)}`)
    })
    await page.locator('[data-testid="quick-row"][data-state="done"]').nth(1).hover()
    await page.waitForTimeout(300)
    await shot('tray-5-hover')
    await page.getByTestId('quick-stem').nth(2).click()
    await page.locator('[data-testid="quick-stem"][data-audition="playing"]').waitFor()
    await page.mouse.move(200, 470)
    await page.waitForTimeout(250)
    await shot('tray-8-listening')
    await page.getByTestId('quick-stem').nth(2).click()
    await page.getByRole('combobox', { name: 'Recipe' }).click()
    await page.waitForTimeout(400)
    await shot('tray-6-recipes')
    await page.getByRole('option', { name: /Drum kit/ }).click()
    await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])
    await page.locator('[data-testid="quick-row"][data-state="done"]').nth(3).waitFor()
    await page.waitForTimeout(700)
    await shot('tray-7-drum-kit')
  } finally {
    await app.close()
  }
})

test('screenshots of the update offer', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page } = await launch({ OPENSTEMS_E2E_UPDATE: '0.3.0' })
  const popup = await trayPage(app)
  try {
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Check for updates' }).click()
    await page.getByRole('button', { name: 'Update to 0.3.0' }).waitFor()
    await page.getByText('Version 0.3.0 is available.').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'update-1-available.png') })
    await clickTray(app)
    await popup.getByRole('button', { name: 'Update 0.3.0', exact: true }).waitFor()
    await popup.waitForTimeout(300)
    await popup.screenshot({ path: join(out, 'update-2-quick-drop.png') })
    await page.getByRole('button', { name: 'Update to 0.3.0' }).click()
    await page.getByRole('button', { name: 'Restart to update' }).first().waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(out, 'update-3-ready.png') })
  } finally {
    await app.close()
  }
})

test('screenshots of manual start', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page, fixtures } = await launch({ OPENSTEMS_AUTO_START: '', OPENSTEMS_FAKE_DELAY: '0.3' })
  const popup = await trayPage(app)
  try {
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.getByTestId('file-input').setInputFiles(
      ['First Song.mp3', 'Second Song.flac', 'Video Clip.mp4'].map((n) => join(fixtures, n)),
    )
    await page.getByRole('button', { name: 'Start 3 songs' }).waitFor()
    await page.getByTestId('job-row').nth(1).hover()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'manual-1-waiting.png') })
    await clickTray(app)
    await popup.getByRole('button', { name: 'Start 3 songs' }).waitFor()
    await popup.waitForTimeout(300)
    await popup.screenshot({ path: join(out, 'manual-2-quick-drop.png') })
    await page.getByTestId('job-row').nth(1).getByRole('button', { name: 'Start this one' }).click()
    await page.locator('[data-testid="job-row"][data-state="running"]').waitFor()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(out, 'manual-3-one-started.png') })
  } finally {
    await app.close()
  }
})

test('screenshots of links and mixes', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const { app, page, fixtures } = await launch({ OPENSTEMS_FAKE_DELAY: '0.05' })
  const popup = await trayPage(app)
  const paste = (target: typeof page, text: string) =>
    target.evaluate((value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)
  try {
    // The full window: an empty queue, then a fetch under way beside a job and a failed one.
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'links-1-empty.png') })
    await page.getByTestId('file-input').setInputFiles([join(fixtures, 'First Song.mp3')])
    await page.locator('[data-testid="job-row"][data-state="done"]').waitFor()
    await paste(page, 'https://example.com/fail/nothing-here')
    await paste(page, 'https://www.youtube.com/slow/Night-Drive')
    await page.locator('[data-testid="link-row"][data-state="downloading"]').waitFor()
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(out, 'links-2-fetching.png') })
    await page.locator('[data-testid="link-row"][data-state="failed"]').hover()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(out, 'links-3-failed-hover.png') })

    // The quick-drop window with the same queue.
    await clickTray(app)
    await popup.locator('[data-testid="link-row"]').first().waitFor()
    await popup.waitForTimeout(400)
    await popup.screenshot({ path: join(out, 'links-4-tray.png') })
    await popup.locator('[data-testid="quick-row"][data-state="done"]').nth(1).waitFor({ timeout: 30_000 })
    const done = popup.locator('[data-testid="quick-row"][data-state="done"]').first()
    await popup.waitForTimeout(600)
    await popup.screenshot({ path: join(out, 'mix-1-before.png') })
    await done.getByTestId('quick-mix').click()
    await popup.mouse.move(200, 480)
    await popup.waitForTimeout(350)
    await popup.screenshot({ path: join(out, 'mix-2-all-in.png') })
    await done.getByTestId('quick-stem').filter({ hasText: 'vocals' }).click()
    await popup.mouse.move(200, 480)
    await popup.waitForTimeout(120)
    await popup.screenshot({ path: join(out, 'mix-3-preparing.png') })
    await done.locator('[data-testid="mix-drag"][data-state="ready"]').waitFor()
    await popup.screenshot({ path: join(out, 'mix-4-no-vocals.png') })
    await done.getByRole('button', { name: 'Play the mix' }).click()
    await done.getByRole('button', { name: 'Pause the mix' }).waitFor()
    await popup.mouse.move(200, 480)
    await popup.waitForTimeout(300)
    await popup.screenshot({ path: join(out, 'mix-5-playing.png') })
    for (const name of ['guitar', 'piano', 'other']) await done.getByTestId('quick-stem').filter({ hasText: name }).click()
    await done.locator('[data-testid="mix-drag"][data-state="ready"]').waitFor()
    await popup.mouse.move(200, 480)
    await popup.waitForTimeout(200)
    await popup.screenshot({ path: join(out, 'mix-6-two-stems.png') })

    // The full window's panel: mute a stem, and the mix can leave.
    await page.locator('[data-testid="job-row"][data-state="done"]').first().click()
    const panel = page.getByRole('complementary', { name: 'Stems' })
    await panel.getByRole('button', { name: 'Mute vocals' }).click()
    await panel.getByTestId('drag-mix').filter({ hasText: 'Drag mix' }).waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'mix-7-panel.png') })
  } finally {
    await app.close()
  }
})

test('screenshots of a machine with little memory', async () => {
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  // The machine acts as 8 GB, and the largest model of the default recipe falls back to the CPU.
  const { app, page, fixtures } = await launch({ OPENSTEMS_MEMORY_GB: '8', OPENSTEMS_FAKE_OOM: 'bs-roformer-sw', OPENSTEMS_FAKE_DELAY: '0.05' })
  const popup = await trayPage(app)
  try {
    await page.getByTestId('file-input').setInputFiles(['First Song.mp3', 'Second Song.flac'].map((n) => join(fixtures, n)))
    await page.locator('[data-testid="job-row"][data-state="done"]').nth(1).waitFor()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, 'memory-1-queue.png') })
    await page.locator('[data-testid="job-row"][data-state="done"]').first().click()
    await page.getByTestId('stem-row').nth(5).waitFor()
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(out, 'memory-2-stems.png') })
    await page.getByRole('combobox', { name: 'Recipe' }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'memory-3-recipes.png') })
    await page.getByRole('option', { name: /best vocals/i }).first().click()
    await page.getByTestId('recipe-fit').hover()
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(out, 'memory-4-too-large.png') })
    await clickTray(app)
    await popup.locator('[data-testid="quick-row"][data-state="done"]').nth(1).waitFor()
    await popup.waitForTimeout(500)
    await popup.screenshot({ path: join(out, 'memory-5-quick-drop.png') })
    await page.getByRole('button', { name: 'Models' }).click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, 'memory-6-models.png') })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByTestId('memory-budget').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'memory-7-settings.png') })
  } finally {
    await app.close()
  }
})

/**
 * A drum loop with a bass line, as a 16-bit WAV: kick on every beat, snare on 2 and 4, hats on
 * the eighths, louder in the third bar. The fixtures are steady tones, which draw as a block.
 */
function writeLoop(path: string, bars: number, bpm: number): void {
  const rate = 44100
  const beat = 60 / bpm
  const n = Math.round(bars * 4 * beat * rate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  let seed = 7
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 1073741824 - 1
  }
  const hit = (at: number, seconds: number, gain: number, sample: (t: number) => number, pan = 0) => {
    const first = Math.round(at * rate)
    for (let i = 0; i < seconds * rate && first + i < n; i++) {
      const value = sample(i / rate) * gain
      left[first + i] = (left[first + i] ?? 0) + value * (1 - pan)
      right[first + i] = (right[first + i] ?? 0) + value * (1 + pan)
    }
  }
  const bassNotes = [55, 55, 65.4, 49]
  for (let b = 0; b < bars * 4; b++) {
    const at = b * beat
    const bar = Math.floor(b / 4)
    const lift = bar === 2 ? 1.25 : 1
    let phase = 0
    hit(at, 0.3, 0.75 * lift, (t) => {
      phase += (2 * Math.PI * (48 + 110 * Math.exp(-t * 28))) / rate
      return Math.sin(phase) * Math.exp(-t * 11)
    })
    if (b % 4 === 1 || b % 4 === 3) {
      hit(at, 0.22, 0.42 * lift, (t) => (noise() * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 22), 0.1)
    }
    for (const half of [0, 0.5]) {
      let last = 0
      hit(
        at + half * beat,
        0.06,
        0.16,
        (t) => {
          const white = noise()
          const high = white - last
          last = white
          return high * Math.exp(-t * 70)
        },
        -0.3,
      )
    }
    const note = bassNotes[bar % bassNotes.length] ?? 55
    hit(at + beat * 0.5, beat * 0.45, 0.28 * lift, (t) => Math.sin(2 * Math.PI * note * t) * Math.min(1, t * 200) * Math.exp(-t * 4))
  }
  const data = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round((left[i] ?? 0) * 26000))), i * 4)
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round((right[i] ?? 0) * 26000))), i * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

/**
 * The trimmer, dark and light (trim-*.png, light-trim-*.png): a separated song as it opens,
 * a part of a stem and of a mix, then a waiting song whose part alone Start separates.
 */
test('screenshots of the trimmer', async () => {
  test.setTimeout(300_000)
  const out = process.env.SHOTS_DIR ?? join(import.meta.dirname, '..', 'test-results', 'shots')
  mkdirSync(out, { recursive: true })
  const songs = mkdtempSync(join(tmpdir(), 'openstems-loops-'))
  writeLoop(join(songs, 'Night Loop.wav'), 8, 120)
  writeLoop(join(songs, 'Day Loop.wav'), 8, 120)
  const { app, page } = await launch({ OPENSTEMS_AUTO_START: '', OPENSTEMS_FAKE_DELAY: '0.05' })
  const editor = page.getByTestId('trim-editor')
  const theme = (name: 'Light' | 'Dark') => page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name }).click()
  const shots = async (name: string) => {
    await page.mouse.move(2, 400)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, `trim-${name}.png`) })
    await theme('Light')
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, `light-trim-${name}.png`) })
    await theme('Dark')
  }
  const select = async (from: number, to: number) => {
    const t0 = Number(await editor.getAttribute('data-t0'))
    const t1 = Number(await editor.getAttribute('data-t1'))
    const box = await page.getByTestId('trim-wave').boundingBox()
    if (!box) throw new Error('no waveform')
    const x = (t: number) => box.x + ((t - t0) / (t1 - t0)) * box.width
    await page.mouse.move(x(from), box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x(to), box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
  }
  /** Bars 2 to 3 on the song's grid, however it was detected. */
  const selectBars = async () => {
    const downbeat = Number(await editor.getAttribute('data-downbeat'))
    const bar = (4 * 60) / Number(await editor.getAttribute('data-bpm'))
    await page.getByRole('radiogroup', { name: 'Snap' }).getByRole('radio', { name: 'Bar', exact: true }).click()
    await select(downbeat + bar * 1.1, downbeat + bar * 2.9)
  }
  const drawn = async () => {
    await page.getByTestId('trim-loading').waitFor({ state: 'detached', timeout: 120_000 })
    await page.locator('[data-testid="trim-editor"][data-wave="audio"]').waitFor({ timeout: 60_000 })
  }
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('switch', { name: 'Separate only the trimmed part' }).click()
    await page.getByRole('button', { name: 'Queue' }).click()
    await page.getByTestId('file-input').setInputFiles([join(songs, 'Night Loop.wav'), join(songs, 'Day Loop.wav')])
    const night = page.getByTestId('job-row').filter({ hasText: 'Night Loop' })
    await night.hover()
    await night.getByRole('button', { name: 'Start this one' }).click()
    await page.locator('[data-testid="job-row"][data-state="done"]').waitFor()

    // A separated song, on its own file, as it opens.
    await night.getByTestId('row-trim').click()
    await drawn()
    await shots('1-open')

    // The drums, bars 2 to 3, the clip written and ready to drag.
    await page.locator('[data-chip="stem:drums"]').click()
    await drawn()
    await selectBars()
    await page.locator('[data-testid="clip-handle"][data-state="ready"]').waitFor()
    await shots('2-part')

    // Two stems as one file (Ctrl+click, Cmd on a Mac), drawn as two layers in their colors,
    // and every stem of the part, one file each.
    await page.locator('[data-chip="stem:bass"]').click({ modifiers: [MOD] })
    await drawn()
    await page.locator('[data-testid="clip-handle"][data-state="ready"]').waitFor()
    await page.getByTestId('all-handle').hover()
    await page.locator('[data-testid="all-handle"][data-state="ready"]').waitFor()
    await shots('3-mix')
    await page.getByTestId('trim-back').click()
    await editor.waitFor({ state: 'detached' })

    // A waiting song with "Separate only the trimmed part" on: the footer says what Start does.
    await page.getByTestId('job-row').filter({ hasText: 'Day Loop' }).getByTestId('row-trim').click()
    await drawn()
    await selectBars()
    await page.getByTestId('start-part').waitFor()
    await shots('4-waiting-part')
    await page.getByTestId('trim-back').click()
    await editor.waitFor({ state: 'detached' })
    // Its row says so too.
    await page.getByTestId('job-status').filter({ hasText: 'only' }).waitFor()
    await shots('5-queue-part')
  } finally {
    await app.close()
  }
})
