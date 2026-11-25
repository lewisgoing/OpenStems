import { spawnSync } from 'node:child_process'
import { app, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { log } from './log'
import { macBundlePath } from './platform'
import {
  type AnyUpdateBackend,
  type ManualUpdateBackend,
  RELEASES_URL,
  type UpdateBackend,
  canInstallUpdates,
  isMissingUpdateFile,
  testFeedUrl,
} from './updatelogic'

/** electron-updater, set up so that nothing happens behind the user's back. */
function updater() {
  const { autoUpdater } = electronUpdater
  // The user starts the download and the restart.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (message: unknown) => log(`updater: ${String(message)}`),
    warn: (message: unknown) => log(`updater warning: ${String(message)}`),
    error: (message: unknown) => log(`updater error: ${String(message)}`),
    debug: () => undefined,
  }
  // Testing only: builds served from a folder stand in for the GitHub releases.
  const feed = testFeedUrl(process.env)
  if (feed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed })
    log(`updates: reading ${feed} (OPENSTEMS_UPDATE_FEED), not the GitHub releases`)
  }
  return autoUpdater
}

async function newerVersion(): Promise<string | null> {
  try {
    const result = await updater().checkForUpdates()
    return result?.isUpdateAvailable ? result.updateInfo.version : null
  } catch (error) {
    // A release without a Mac build (not uploaded yet, or Windows only) offers a Mac
    // nothing. That is not an error to show. Windows keeps its error as it was.
    if (process.platform === 'darwin' && isMissingUpdateFile(error)) {
      log('updates: the latest release has no Mac build')
      return null
    }
    throw error
  }
}

/**
 * electron-updater against the GitHub releases named in the build's `publish` setting. A
 * release carries the installer, its blockmap and `latest.yml` (on a Mac, the zip and
 * `latest-mac.yml`), which names the version and the file's sha512; the download is checked
 * against that before it is run.
 */
export function githubBackend(): UpdateBackend {
  const autoUpdater = updater()
  return {
    check: newerVersion,
    async download(onProgress) {
      const report = (info: { percent: number }) => onProgress(info.percent / 100)
      autoUpdater.on('download-progress', report)
      try {
        await autoUpdater.downloadUpdate()
      } finally {
        autoUpdater.removeListener('download-progress', report)
      }
    },
    install() {
      // Silent, and start the new version afterwards. The installer is per user: no prompt.
      autoUpdater.quitAndInstall(true, true)
    },
  }
}

/**
 * The same check, and nothing more: the version comes from `latest-mac.yml` in the latest
 * release, so a release without a Mac build offers nothing. The new version is fetched by
 * the user, from the release page.
 */
export function checkOnlyBackend(): ManualUpdateBackend {
  return {
    check: newerVersion,
    url: RELEASES_URL,
    open: (url) => shell.openExternal(url),
  }
}

/**
 * Whether this Mac app is signed with a certificate: a Developer ID, or one the project
 * made itself. macOS installs an update only into an app signed by the same certificate as
 * the update; a build made without one is signed ad hoc and names no authority
 * (`canInstallUpdates`). Asked once, at start: `codesign` answers in a few hundredths of
 * a second.
 */
function macAppIsSigned(): boolean {
  try {
    const bundle = macBundlePath(app.getPath('exe'))
    // codesign prints what it finds on stderr.
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8', timeout: 5000 })
    if (result.error) throw result.error
    return canInstallUpdates([result.stdout, result.stderr].join('\n'))
  } catch (error) {
    log(`could not read the app's signature: ${String(error)}`)
    return false
  }
}

/**
 * The backend for an installed app. Windows, and a Mac app signed with a certificate,
 * update themselves. A Mac app signed ad hoc only looks, and sends the user to the release page.
 */
export function updateBackend(): AnyUpdateBackend {
  if (process.platform !== 'darwin') return githubBackend()
  const signed = macAppIsSigned()
  log(`updates: ${signed ? 'signed with a certificate, the app updates itself' : 'signed ad hoc, a new version opens the release page'}`)
  return signed ? githubBackend() : checkOnlyBackend()
}
