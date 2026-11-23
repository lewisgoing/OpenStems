import electronUpdater from 'electron-updater'
import { log } from './log'
import type { UpdateBackend } from './updatelogic'

/**
 * electron-updater against the GitHub releases named in the build's `publish` setting. A
 * release carries the installer, its blockmap and `latest.yml`, which names the version and
 * the installer's sha512; the download is checked against that before it is run.
 */
export function githubBackend(): UpdateBackend {
  const { autoUpdater } = electronUpdater
  // The user starts the download and the restart: nothing happens behind their back.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (message: unknown) => log(`updater: ${String(message)}`),
    warn: (message: unknown) => log(`updater warning: ${String(message)}`),
    error: (message: unknown) => log(`updater error: ${String(message)}`),
    debug: () => undefined,
  }
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates()
      return result?.isUpdateAvailable ? result.updateInfo.version : null
    },
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
