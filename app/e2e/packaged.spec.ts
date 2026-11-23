import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

// The packaged app on a clean profile: first-run setup, then a separation on the GPU.
// Not part of CI: it downloads Python and PyTorch (about 3 GB) and needs the models.
//
//   pnpm pack
//   PACKAGED_PROFILE=D:\tmp\fresh REAL_SONG=D:\song.mp3 REAL_MODELS=D:\models pnpm e2e -g packaged
//
// To test an installed copy in your real profile instead, name its exe and leave the
// profile out:
//   PACKAGED_EXE="%LOCALAPPDATA%\Programs\OpenStems\OpenStems.exe" REAL_SONG=... pnpm e2e -g packaged
//
// PACKAGED_VARIANT=rocm forces the AMD build whatever card the machine has. Without a
// supported Radeon the test stops after setup, once Settings shows the ROCm build and says
// why the CPU is in use (REAL_SONG is then not needed). With one, it goes
// on to a separation on the Radeon.
const profile = process.env.PACKAGED_PROFILE
const song = process.env.REAL_SONG
const models = process.env.REAL_MODELS
const installed = process.env.PACKAGED_EXE
const exe = installed ?? resolve(import.meta.dirname, '..', 'release', 'win-unpacked', 'OpenStems.exe')
const variant = process.env.PACKAGED_VARIANT
const ready = variant === 'rocm' ? Boolean(profile && models) : Boolean(song && (installed || (profile && models)))

test('packaged app: first-run setup, then the first separation, with no terminal', async () => {
  test.skip(!ready, 'set REAL_SONG and either PACKAGED_EXE or PACKAGED_PROFILE + REAL_MODELS (PACKAGED_VARIANT=rocm needs no song unless a Radeon is present)')
  test.setTimeout(45 * 60_000)
  expect(existsSync(exe), 'run `pnpm pack` first').toBe(true)
  // Installed copy: the real profile, untouched. Unpacked build: a fresh Windows account is
  // simulated by pointing the profile folders somewhere empty.
  const local = installed ? (process.env.LOCALAPPDATA ?? '') : join(profile ?? '', 'Local')
  const roaming = installed ? (process.env.APPDATA ?? '') : join(profile ?? '', 'Roaming')
  const outputs = installed ? null : join(profile ?? '', 'outputs')
  if (!installed) for (const dir of [local, roaming]) mkdirSync(dir, { recursive: true })
  const env = { ...(process.env as Record<string, string>) }
  for (const key of ['OPENSTEMS_ENGINE', 'OPENSTEMS_CONFIG_DIR', 'OPENSTEMS_CACHE_DIR', 'OPENSTEMS_E2E']) delete env[key]
  if (!installed) {
    Object.assign(env, {
      LOCALAPPDATA: local,
      APPDATA: roaming,
      OPENSTEMS_MODELS_DIR: models ?? '',
      OPENSTEMS_OUTPUT_DIR: outputs ?? '',
    })
  }
  if (variant) env.OPENSTEMS_TORCH_VARIANT = variant
  const app = await electron.launch({
    executablePath: exe,
    // Its own browser-data folder, so the test can run beside an app that is already open
    // (one instance per data folder is allowed).
    args: [`--user-data-dir=${installed ? mkdtempSync(join(tmpdir(), 'openstems-installed-')) : join(roaming, 'openstems-user-data')}`],
    env,
  })
  try {
    const page = await app.firstWindow()
    const setup = page.getByRole('heading', { name: 'Set up the audio engine' })
    const nav = page.getByRole('navigation', { name: 'Views' })
    await expect(setup.or(nav)).toBeVisible({ timeout: 60_000 })

    if (await setup.isVisible()) {
      // Setup waits for the graphics card check, then offers the build that fits.
      const fits = variant === 'rocm' ? 'AMD Radeon' : 'NVIDIA'
      await expect(page.getByRole('radio', { name: fits })).toBeChecked({ timeout: 30_000 })
      if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, `setup-${variant ?? 'cuda'}.png`) })
      await page.getByRole('button', { name: 'Set up' }).click()
      await expect(page.getByRole('button', { name: 'Setting up' })).toBeVisible()
      // Python, PyTorch and the model code download and install here.
      await expect(nav).toBeVisible({ timeout: 40 * 60_000 })
      expect(existsSync(join(local, 'OpenStems', 'engine-env', 'Scripts', 'openstems.exe'))).toBe(true)
    }

    // The doctor result is on the Settings page: the GPU must be available.
    await page.getByRole('button', { name: 'Settings' }).click()
    if (variant === 'rocm') {
      await expect(page.getByText(/PyTorch 2\.9\.1\+rocm.*ROCm 7/)).toBeVisible({ timeout: 90_000 })
      const build = page.getByText('PyTorch for AMD Radeon graphics cards.', { exact: false })
      await expect(build).toBeVisible()
      await build.scrollIntoViewIfNeeded()
      if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'settings-rocm.png') })
      if ((await page.getByRole('alert').count()) > 0) {
        // No supported Radeon here: the app says so and runs on the CPU. Nothing more to check.
        await expect(page.getByRole('alert').first()).toContainText('found no supported Radeon GPU')
        return
      }
      await expect(page.getByText(/Radeon/).first()).toBeVisible()
    } else {
      await expect(page.getByText(/RTX|GeForce|NVIDIA/).first()).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText(/CUDA 13/)).toBeVisible()
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Queue' }).click()

    await page.getByRole('radio', { name: 'Fast' }).click()
    // A profile that was used before already has jobs in its list: wait for the new row,
    // so an older finished job is not mistaken for this one.
    const before = await page.getByTestId('job-row').count()
    await page.getByTestId('file-input').setInputFiles([song ?? ''])
    await expect(page.getByTestId('job-row')).toHaveCount(before + 1)
    const row = page.getByTestId('job-row').last()
    await expect(row).toHaveAttribute('data-state', 'done', { timeout: 10 * 60_000 })
    await row.click()
    // The recipe is the profile's default, so the number of stems varies.
    await expect(page.getByTestId('stem-row').first()).toBeVisible()
    const stemCount = await page.getByTestId('stem-row').count()
    if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'packaged.png') })

    // The stems are real files in the job's output folder.
    await page.getByTestId('drag-all').waitFor()
    const paths = JSON.parse((await page.getByTestId('drag-all').getAttribute('data-paths')) ?? '[]') as string[]
    expect(paths).toHaveLength(stemCount)
    for (const path of paths) expect(existsSync(path)).toBe(true)
    if (outputs) expect(readdirSync(outputs).length).toBeGreaterThan(0)
    // Logs land in the profile, where Export diagnostics picks them up.
    expect(existsSync(join(local, 'OpenStems', 'logs', 'engine.log'))).toBe(true)

    // The GPU self-test from Settings: the GPU must agree with the CPU. Only on request
    // (PACKAGED_SELFTEST=1): it runs the models flat out on the GPU and then on every CPU
    // core, and the development machine has twice lost power while it ran.
    if (process.env.PACKAGED_SELFTEST !== '1') return
    await page.getByRole('button', { name: 'Settings' }).click()
    const run = page.getByRole('button', { name: 'Run', exact: true })
    await run.scrollIntoViewIfNeeded()
    await run.click()
    await expect(page.getByText(/The GPU passed\.|The GPU self-test found a problem\./)).toBeVisible({ timeout: 20 * 60_000 })
    if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, `selftest-${variant ?? 'cuda'}.png`) })
    await expect(page.getByText('The GPU passed.')).toBeVisible()
    expect(existsSync(join(local, 'OpenStems', 'logs', 'selftest.json'))).toBe(true)
  } finally {
    await app.close()
  }
})

// Switching the build from Settings, on a profile where setup has already run:
//
//   PACKAGED_SWITCH=cuda PACKAGED_PROFILE=D:\tmp\fresh REAL_MODELS=D:\models pnpm e2e -g "switch the engine build"
//
// PACKAGED_SWITCH names the build to end up with. It downloads that build's PyTorch.
const switchTo = process.env.PACKAGED_SWITCH
test('packaged app: switch the engine build from Settings', async () => {
  test.skip(!(switchTo === 'cuda' || switchTo === 'rocm') || !profile || !models, 'set PACKAGED_SWITCH, PACKAGED_PROFILE and REAL_MODELS')
  test.setTimeout(45 * 60_000)
  const local = join(profile ?? '', 'Local')
  const roaming = join(profile ?? '', 'Roaming')
  const marker = join(local, 'OpenStems', 'engine-env', '.openstems-version')
  expect(existsSync(marker), 'run the first-run test on this profile first').toBe(true)
  const from = switchTo === 'cuda' ? 'rocm' : 'cuda'
  expect(readFileSync(marker, 'utf8')).toContain(from)

  const env = { ...(process.env as Record<string, string>) }
  for (const key of ['OPENSTEMS_ENGINE', 'OPENSTEMS_CONFIG_DIR', 'OPENSTEMS_CACHE_DIR', 'OPENSTEMS_E2E', 'OPENSTEMS_TORCH_VARIANT']) delete env[key]
  Object.assign(env, { LOCALAPPDATA: local, APPDATA: roaming, OPENSTEMS_MODELS_DIR: models ?? '', OPENSTEMS_OUTPUT_DIR: join(profile ?? '', 'outputs') })
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${join(roaming, 'openstems-user-data')}`], env })
  try {
    const page = await app.firstWindow()
    const nav = page.getByRole('navigation', { name: 'Views' })
    // The installed build is kept: detection alone never swaps it.
    await expect(nav).toBeVisible({ timeout: 90_000 })
    await page.getByRole('button', { name: 'Settings' }).click()
    const label = switchTo === 'cuda' ? 'NVIDIA' : 'AMD Radeon'
    const button = page.getByRole('button', { name: `Switch to ${label}` })
    await button.scrollIntoViewIfNeeded()
    if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, `settings-before-switch-to-${switchTo}.png`) })
    await button.click()
    await expect(page.getByRole('dialog')).toContainText('Your models, stems and settings are not touched')
    await page.getByRole('button', { name: 'Switch and download' }).click()

    // The engine stops, the setup screen takes over, then the app comes back.
    await expect(page.getByRole('button', { name: 'Setting up' })).toBeVisible({ timeout: 30_000 })
    await expect(nav).toBeVisible({ timeout: 40 * 60_000 })
    expect(readFileSync(marker, 'utf8')).toContain(switchTo ?? '')
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByText(switchTo === 'cuda' ? /CUDA 13/ : /ROCm 7/)).toBeVisible({ timeout: 90_000 })
    await expect(page.getByRole('button', { name: `Switch to ${from === 'cuda' ? 'NVIDIA' : 'AMD Radeon'}` })).toBeVisible()
  } finally {
    await app.close()
  }
})
