import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { MAC, WINDOWS, cleanProfile, packagedExe, realProfile } from './helpers'

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
// PACKAGED_VARIANT=cu126 forces the build for older NVIDIA cards. On a newer card the test
// stops after setup, once Settings says the build does not support the card.
//
// PACKAGED_VARIANT=rocm forces the AMD build whatever card the machine has. Without a
// supported Radeon the test stops after setup, once Settings shows the ROCm build and says
// why the CPU is in use (REAL_SONG is then not needed). With one, it goes
// on to a separation on the Radeon.
//
// On a Mac (not yet run on one by us):
//
//   pnpm package:prepare && pnpm run pack:mac
//   PACKAGED_PROFILE=/tmp/fresh REAL_SONG=~/song.mp3 REAL_MODELS=~/models pnpm e2e -g packaged
//
// The clean profile is a home folder: HOME points at PACKAGED_PROFILE, so the engine goes to
// its Library/Application Support/OpenStems and uv downloads Python and PyTorch again. There
// is one build (Apple Silicon), so PACKAGED_VARIANT and the switch test are for Windows.
const profile = process.env.PACKAGED_PROFILE
const song = process.env.REAL_SONG
const models = process.env.REAL_MODELS
const installed = process.env.PACKAGED_EXE
const exe = installed ?? packagedExe()
// The Windows builds can be forced. A Mac has one.
const variant = MAC ? undefined : process.env.PACKAGED_VARIANT
const build = variant ?? (MAC ? 'mps' : 'cuda')
// A forced build may find no card it can run here: then the test stops after setup and needs no song.
const forced = variant === 'rocm' || variant === 'cu126'
const ready = forced ? Boolean(profile && models) : Boolean(song && (installed || (profile && models)))
const LABEL: Record<string, string> = { cuda: 'NVIDIA', cu126: 'NVIDIA (older)', rocm: 'AMD Radeon', mps: 'Apple Silicon' }

test('packaged app: first-run setup, then the first separation, with no terminal', async () => {
  test.skip(!ready, 'set REAL_SONG and either PACKAGED_EXE or PACKAGED_PROFILE + REAL_MODELS (PACKAGED_VARIANT=rocm needs no song unless a Radeon is present)')
  test.setTimeout(45 * 60_000)
  expect(existsSync(exe), MAC ? 'run `pnpm run pack:mac` first' : 'run `pnpm run pack` first').toBe(true)
  // Installed copy: the real profile, untouched. Unpacked build: a fresh user account is
  // simulated by pointing the profile folders (on a Mac, the home folder) somewhere empty.
  const account = installed ? realProfile() : cleanProfile(profile ?? '')
  const outputs = installed ? null : join(profile ?? '', 'outputs')
  const env = { ...(process.env as Record<string, string>) }
  for (const key of ['OPENSTEMS_ENGINE', 'OPENSTEMS_CONFIG_DIR', 'OPENSTEMS_CACHE_DIR', 'OPENSTEMS_E2E']) delete env[key]
  if (!installed) {
    Object.assign(env, account.env, {
      OPENSTEMS_MODELS_DIR: models ?? '',
      OPENSTEMS_OUTPUT_DIR: outputs ?? '',
    })
  }
  if (variant) env.OPENSTEMS_TORCH_VARIANT = variant
  const app = await electron.launch({
    executablePath: exe,
    // Its own browser-data folder, so the test can run beside an app that is already open
    // (one instance per data folder is allowed).
    args: [`--user-data-dir=${account.userData}`],
    // The pages take their theme from Electron, not from Playwright's stand-in.
    colorScheme: null,
    env,
  })
  try {
    const page = await app.firstWindow()
    const setup = page.getByRole('heading', { name: 'Set up the audio engine' })
    const nav = page.getByRole('navigation', { name: 'Views' })
    await expect(setup.or(nav)).toBeVisible({ timeout: 60_000 })

    if (await setup.isVisible()) {
      if (MAC) {
        // One build: nothing to detect and nothing to choose.
        await expect(page.getByRole('radio')).toHaveCount(0)
      } else {
        // Setup waits for the graphics card check, then offers the build that fits.
        const fits = LABEL[build] ?? 'NVIDIA'
        await expect(page.getByRole('radio', { name: fits, exact: true })).toBeChecked({ timeout: 30_000 })
      }
      if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, `setup-${build}.png`) })
      await page.getByRole('button', { name: 'Set up' }).click()
      await expect(page.getByRole('button', { name: 'Setting up' })).toBeVisible()
      // Python, PyTorch and the model code download and install here.
      await expect(nav).toBeVisible({ timeout: 40 * 60_000 })
      expect(existsSync(account.program('openstems'))).toBe(true)
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
    } else if (variant === 'cu126') {
      await expect(page.getByText(/PyTorch 2\.14\.1\+cu126.*CUDA 12\.6/)).toBeVisible({ timeout: 90_000 })
      if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'settings-cu126.png') })
      if ((await page.getByRole('alert').count()) > 0) {
        // A card newer than this build knows: the app says which build to switch to and
        // runs on the CPU. Nothing more to check here.
        await expect(page.getByRole('alert').first()).toContainText('does not support')
        await expect(page.getByRole('alert').first()).toContainText("Switch the engine build to 'NVIDIA'")
        return
      }
    } else if (MAC) {
      // The Apple GPU: the chip's name, its backend, and no problem reported.
      await expect(page.getByText(/Apple (M\d|GPU)/).first()).toBeVisible({ timeout: 90_000 })
      await expect(page.getByText(/Metal|MPS/).first()).toBeVisible()
      if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'settings-mps.png') })
      await expect(page.getByRole('alert')).toHaveCount(0)
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
    // Songs wait for Start unless the profile has "Start songs automatically" on.
    const added = page.getByTestId('job-row').last()
    const status = added.getByTestId('job-status')
    await expect(status).not.toHaveText('')
    if ((await status.textContent()) === 'Ready to start') {
      await page.getByRole('button', { name: /^Start \d+ songs?$/ }).click()
    }
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
    expect(existsSync(join(account.logs, 'engine.log'))).toBe(true)

    // The GPU self-test from Settings: the GPU must agree with the CPU. Only on request
    // (PACKAGED_SELFTEST=1): it runs the models flat out on the GPU and then on every CPU
    // core, and the development machine has twice lost power while it ran.
    if (process.env.PACKAGED_SELFTEST !== '1') return
    await page.getByRole('button', { name: 'Settings' }).click()
    const run = page.getByRole('button', { name: 'Run', exact: true })
    await run.scrollIntoViewIfNeeded()
    await run.click()
    await expect(page.getByText(/The GPU passed\.|The GPU self-test found a problem\./)).toBeVisible({ timeout: 20 * 60_000 })
    if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, `selftest-${build}.png`) })
    await expect(page.getByText('The GPU passed.')).toBeVisible()
    expect(existsSync(join(account.logs, 'selftest.json'))).toBe(true)
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
  test.skip(!WINDOWS, 'Windows only: a Mac has one build and nothing to switch to')
  test.skip(!(switchTo && switchTo in LABEL) || !profile || !models, 'set PACKAGED_SWITCH, PACKAGED_PROFILE and REAL_MODELS')
  test.setTimeout(45 * 60_000)
  const account = cleanProfile(profile ?? '')
  const marker = join(account.engineEnv, '.openstems-version')
  expect(existsSync(marker), 'run the first-run test on this profile first').toBe(true)
  const from = readFileSync(marker, 'utf8').trim().split(/\s+/)[1] ?? 'cuda'
  expect(from, 'the profile already holds that build').not.toBe(switchTo)

  const env = { ...(process.env as Record<string, string>) }
  for (const key of ['OPENSTEMS_ENGINE', 'OPENSTEMS_CONFIG_DIR', 'OPENSTEMS_CACHE_DIR', 'OPENSTEMS_E2E', 'OPENSTEMS_TORCH_VARIANT']) delete env[key]
  Object.assign(env, account.env, { OPENSTEMS_MODELS_DIR: models ?? '', OPENSTEMS_OUTPUT_DIR: join(profile ?? '', 'outputs') })
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${account.userData}`], env, colorScheme: null })
  try {
    const page = await app.firstWindow()
    const nav = page.getByRole('navigation', { name: 'Views' })
    // The installed build is kept: detection alone never swaps it.
    await expect(nav).toBeVisible({ timeout: 90_000 })
    await page.getByRole('button', { name: 'Settings' }).click()
    const build = page.getByRole('combobox', { name: 'Engine build' })
    await build.scrollIntoViewIfNeeded()
    await expect(build).toHaveText(LABEL[from] ?? '')
    if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, `settings-before-switch-to-${switchTo}.png`) })
    await build.click()
    await page.getByRole('option', { name: new RegExp(`^${(LABEL[switchTo ?? ''] ?? '').replace(/[()]/g, '\\$&')}`) }).click()
    await expect(page.getByRole('dialog')).toContainText('Your models, stems and settings are not touched')
    await page.getByRole('button', { name: 'Switch and download' }).click()

    // The engine stops, the setup screen takes over, then the app comes back.
    await expect(page.getByRole('button', { name: 'Setting up' })).toBeVisible({ timeout: 30_000 })
    await expect(nav).toBeVisible({ timeout: 40 * 60_000 })
    expect(readFileSync(marker, 'utf8')).toContain(switchTo ?? '')
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByText(switchTo === 'cuda' ? /CUDA 13/ : switchTo === 'cu126' ? /CUDA 12\.6/ : /ROCm 7/)).toBeVisible({ timeout: 90_000 })
    await expect(page.getByRole('combobox', { name: 'Engine build' })).toHaveText(LABEL[switchTo ?? ''] ?? '')
  } finally {
    await app.close()
  }
})
