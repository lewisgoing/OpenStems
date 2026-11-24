import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { UpdateStatus } from '../electron/bridge'
import { MAC } from './helpers'

// A Mac app signed with a certificate of our own (no Apple Developer ID) installs an update
// signed with the same certificate. Run by `scripts/mac-update-test.sh` on the Mac CI
// runner, which builds both versions, serves the newer one from this machine and sets:
//
//   MAC_UPDATE_APP     the older build, a copy that may be replaced: <folder>/OpenStems.app
//   MAC_UPDATE_ENGINE  an engine to start in place of first-run setup (the FakeEngine)
//   MAC_UPDATE_FEED    where the newer one is served, passed to the app as OPENSTEMS_UPDATE_FEED
//
// The real updater runs here, not a stand-in: electron-updater fetches the zip and hands
// it to the installer inside Electron (Squirrel), which is the part that checks the
// signature.
const bundle = process.env.MAC_UPDATE_APP
const engine = process.env.MAC_UPDATE_ENGINE
const feed = process.env.MAC_UPDATE_FEED

function bundleVersion(app: string): string {
  const plist = join(app, 'Contents', 'Info.plist')
  return execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()
}

test('mac update: a self-signed app installs a newer self-signed version', async () => {
  test.skip(!MAC, 'Mac only')
  test.skip(!bundle || !engine || !feed, 'run through scripts/mac-update-test.sh')
  test.setTimeout(10 * 60_000)
  const installed = bundle ?? ''
  const root = mkdtempSync(join(tmpdir(), 'openstems-update-'))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OPENSTEMS_ENGINE: 'fake',
    OPENSTEMS_ENGINE_CMD: JSON.stringify([engine]),
    OPENSTEMS_CONFIG_DIR: join(root, 'config'),
    OPENSTEMS_MODELS_DIR: join(root, 'models'),
    OPENSTEMS_OUTPUT_DIR: join(root, 'outputs'),
    OPENSTEMS_CACHE_DIR: join(root, 'cache'),
    OPENSTEMS_UPDATE_FEED: feed ?? '',
  }
  for (const key of ['OPENSTEMS_E2E', 'OPENSTEMS_E2E_UPDATE', 'OPENSTEMS_E2E_UPDATE_MANUAL']) delete env[key]

  const before = bundleVersion(installed)
  const app = await electron.launch({
    executablePath: join(installed, 'Contents', 'MacOS', 'OpenStems'),
    args: [`--user-data-dir=${join(root, 'user-data')}`],
    env,
  })
  let offered = ''
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => typeof window.openstems?.updates === 'function')

    const found: UpdateStatus = await page.evaluate(() => window.openstems.checkForUpdates())
    expect(found.error).toBeUndefined()
    expect(found.state).toBe('available')
    // The app means to install it itself: a build signed ad hoc would say `manual` here.
    expect(found.manual ?? false).toBe(false)
    expect(found.current).toBe(before)
    offered = found.version ?? ''
    expect(offered).not.toBe(before)
    console.log(`running ${found.current}, offered ${offered}`)

    // "ready" comes only after the installer has fetched the new bundle and checked its
    // signature against the running app's.
    const done: UpdateStatus = await page.evaluate(() => window.openstems.downloadUpdate())
    expect(done.error).toBeUndefined()
    expect(done.state).toBe('ready')

    const closed = app.waitForEvent('close', { timeout: 60_000 })
    // The app quits while this call is still open, so its answer may never arrive.
    await page.evaluate(() => window.openstems.installUpdate(true)).catch(() => undefined)
    await closed
  } finally {
    await app.close().catch(() => undefined)
  }
  // The installer swaps the bundle after the app has quit, then starts the new version.
  await expect.poll(() => bundleVersion(installed), { timeout: 120_000, intervals: [2000] }).toBe(offered)
  console.log(`the bundle is now ${bundleVersion(installed)}`)
})
