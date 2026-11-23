import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import type { UpdateStatus } from '../electron/bridge'
import { WINDOWS, cleanProfile, packagedExe } from './helpers'

// Self-update against the real GitHub release. Not part of CI: it needs a packaged build
// with an older version number than the latest release, and it downloads the installer.
//
//   pnpm build
//   pnpm exec electron-builder --win --dir --publish never -c.extraMetadata.version=0.1.9
//   copy app-update.yml from an installer build into release/win-unpacked/resources (a
//   folder-only build does not write it)
//   REAL_UPDATE_PROFILE=<empty folder> pnpm e2e -g "real update"
//
// It stops once the new version is downloaded and verified. It does not restart into it:
// that would install the app on this machine.
//
// Windows only. A Mac build updates itself only when it is signed with a Developer ID, and
// a build made here is not: it offers the release page instead, which `update.spec.ts`
// covers with a stand-in.
const profile = process.env.REAL_UPDATE_PROFILE
const exe = packagedExe()

test('real update: an older build finds the latest release and downloads it', async () => {
  test.skip(!WINDOWS, 'Windows only: it downloads the Windows installer')
  test.skip(!profile, 'set REAL_UPDATE_PROFILE to an empty folder')
  test.setTimeout(15 * 60_000)
  expect(existsSync(exe), 'build the unpacked app first').toBe(true)
  const account = cleanProfile(profile ?? '')
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...account.env }
  for (const key of ['OPENSTEMS_E2E', 'OPENSTEMS_E2E_UPDATE', 'OPENSTEMS_E2E_UPDATE_MANUAL', 'OPENSTEMS_ENGINE']) delete env[key]

  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${account.userData}`], env })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => typeof window.openstems?.updates === 'function')
    const before = await page.evaluate(() => window.openstems.updates())
    expect(before.supported).toBe(true)

    const found: UpdateStatus = await page.evaluate(() => window.openstems.checkForUpdates())
    expect(found.error).toBeUndefined()
    expect(found.state).toBe('available')
    expect(found.version).not.toBe(found.current)
    console.log(`running ${found.current}, offered ${found.version}`)
    // The offer is on screen, whatever else the window shows.
    await expect(page.getByRole('button', { name: `Update to ${found.version}` })).toBeVisible()

    const done: UpdateStatus = await page.evaluate(() => window.openstems.downloadUpdate())
    expect(done.error).toBeUndefined()
    expect(done.state).toBe('ready')
    await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible()

    // The verified installer is in the updater's cache.
    const pending = join(account.updaterCache, 'pending')
    console.log(`downloaded: ${readdirSync(pending).join(', ')}`)
    expect(readdirSync(pending).some((file) => file.endsWith('.exe'))).toBe(true)
  } finally {
    await app.close()
  }
})
