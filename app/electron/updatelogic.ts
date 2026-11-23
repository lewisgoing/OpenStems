import type { UpdateStatus } from './bridge'

/** What does the checking, downloading and installing. Tests swap in one with no network. */
export interface UpdateBackend {
  /** The version on offer when it is newer than this one, else null. */
  check(): Promise<string | null>
  download(onProgress: (fraction: number) => void): Promise<void>
  /** Quit, install the downloaded version silently, and start it. */
  install(): void
}

/** Stands in for the network in tests: `version` is on offer and "downloads" in a moment. */
export function fakeBackend(version: string, onInstall: () => void, stepMs = 120): UpdateBackend {
  return {
    check: async () => version,
    async download(onProgress) {
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        await new Promise((resolve) => setTimeout(resolve, stepMs))
        onProgress(fraction)
      }
    },
    install: onInstall,
  }
}

/** Where the newest release is, for an app that cannot install it by itself. */
export const RELEASES_URL = 'https://github.com/lewisgoing/OpenStems/releases/latest'

/**
 * A backend that only looks. An unsigned Mac app cannot replace itself, so there the app
 * says a new version exists and opens the page it can be downloaded from.
 */
export interface ManualUpdateBackend {
  check(): Promise<string | null>
  /** The page with the new version. Only an https address is ever opened. */
  url: string
  /** Open that page in the browser. */
  open(url: string): Promise<void>
}

export type AnyUpdateBackend = UpdateBackend | ManualUpdateBackend

const isManual = (backend: AnyUpdateBackend): backend is ManualUpdateBackend => 'open' in backend

/** The stand-in for a backend that only looks: `version` is on offer, and `onOpen` gets the page. */
export function fakeManualBackend(version: string, onOpen: (url: string) => void, url = RELEASES_URL): ManualUpdateBackend {
  return { check: async () => version, url, open: async (page) => onOpen(page) }
}

/**
 * Whether an app with this signature can install an update, from what `codesign -dv
 * --verbose=2` prints for it. macOS puts a new version in place only when it is signed by
 * whoever signed the running one, so the signature has to name somebody, the same somebody
 * in every release. Two kinds do:
 *
 * - a Developer ID certificate, from Apple;
 * - a certificate the project made itself (self-signed): one authority, and no Apple root.
 *   It asks nothing of Apple. macOS still asks before the first open, as for an unsigned app.
 *
 * An ad hoc signature names nobody and is different in every build. An Apple development
 * certificate is for one developer's machines, not for releases.
 */
export function canInstallUpdates(codesignOutput: string): boolean {
  if (/^Signature=adhoc$/m.test(codesignOutput)) return false
  const authorities = [...codesignOutput.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]?.trim() ?? '')
  if (authorities.length === 0) return false
  if (authorities[0]?.startsWith('Developer ID Application:')) return true
  return authorities.length === 1 && !/^(Apple |Mac Developer|Developer ID |3rd Party Mac |iPhone )/.test(authorities[0] ?? '')
}

/**
 * Whether a failed check means "the latest release has no update file for this system":
 * electron-updater's error when `latest-mac.yml` is not among the release's files. That is
 * a release whose Mac build is not there yet, or never will be, not a broken connection.
 */
export function isMissingUpdateFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
}

const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

type Listener = (status: UpdateStatus) => void

interface UpdaterOptions {
  /** The version that is running. */
  current: string
  /** Null where the app cannot update itself (development). */
  backend: AnyUpdateBackend | null
  /** Runs before the installer takes over: everything of the app's must have stopped. */
  beforeInstall: () => Promise<void>
  /** What the user calls this computer, for "Is this PC online?". */
  computer?: string
  log?: (message: string) => void
}

/**
 * Self-update: look for a newer release, download it when the user says so, then restart
 * into it. One state at a time, sent to every window. Nothing is downloaded or installed
 * unless the user asked for it.
 *
 * With a backend that only looks, the offer is marked `manual` and "download" opens the
 * release page in the browser. The state stays at `available`: the app cannot know whether
 * the user went on to install anything.
 */
export class Updater {
  status: UpdateStatus
  private readonly backend: AnyUpdateBackend | null
  private readonly beforeInstall: () => Promise<void>
  private readonly computer: string
  private readonly log: (message: string) => void
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false

  constructor(options: UpdaterOptions) {
    this.backend = options.backend
    this.beforeInstall = options.beforeInstall
    this.computer = options.computer ?? 'PC'
    this.log = options.log ?? (() => undefined)
    this.status = { state: 'idle', current: options.current, supported: options.backend !== null }
  }

  onStatus(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const listener of this.listeners) listener(this.status)
  }

  /** Check shortly after start and then a few times a day, while `enabled` says so. */
  schedule(enabled: () => boolean): void {
    if (!this.backend || this.timer) return
    const tick = () => {
      if (enabled()) void this.check()
    }
    setTimeout(tick, FIRST_CHECK_MS)
    this.timer = setInterval(tick, CHECK_EVERY_MS)
  }

  /** Look for a newer version. A `manual` check tells the user when it could not be made. */
  async check(manual = false): Promise<UpdateStatus> {
    const { backend } = this
    // A check never interrupts a download, and never forgets a version that is ready.
    if (!backend || this.busy || this.status.state === 'downloading' || this.status.state === 'ready') return this.status
    this.busy = true
    const known = this.status.state === 'available' ? this.status.version : undefined
    this.set({ state: 'checking', error: undefined })
    try {
      const version = await backend.check()
      const offer = isManual(backend) ? { manual: true, url: backend.url } : {}
      if (version) this.set({ state: 'available', version, checkedAt: Date.now(), ...offer })
      else this.set({ state: 'idle', version: undefined, manual: undefined, url: undefined, checkedAt: Date.now() })
    } catch (error) {
      this.log(`update check failed: ${error instanceof Error ? error.message : String(error)}`)
      // No network is the usual reason. A check the app made by itself stays quiet about it.
      this.set({
        state: known ? 'available' : 'idle',
        version: known,
        error: manual ? `Could not check for updates. Is this ${this.computer} online?` : undefined,
      })
    } finally {
      this.busy = false
    }
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    const { backend } = this
    if (!backend || this.busy || this.status.state !== 'available') return this.status
    if (isManual(backend)) return this.openReleasePage(backend)
    this.busy = true
    this.set({ state: 'downloading', progress: 0, error: undefined })
    try {
      await backend.download((fraction) => {
        if (this.status.state === 'downloading') this.set({ progress: Math.max(0, Math.min(1, fraction)) })
      })
      this.set({ state: 'ready', progress: 1 })
    } catch (error) {
      this.log(`update download failed: ${error instanceof Error ? error.message : String(error)}`)
      this.set({ state: 'available', progress: undefined, error: 'The download did not finish. Try again.' })
    } finally {
      this.busy = false
    }
    return this.status
  }

  /** The manual update: the release page in the browser, and the offer stays as it is. */
  private async openReleasePage(backend: ManualUpdateBackend): Promise<UpdateStatus> {
    this.busy = true
    try {
      if (!backend.url.startsWith('https://')) throw new Error(`not an https address: ${backend.url}`)
      await backend.open(backend.url)
      if (this.status.error) this.set({ error: undefined })
    } catch (error) {
      this.log(`could not open the release page: ${error instanceof Error ? error.message : String(error)}`)
      this.set({ error: 'Could not open the download page.' })
    } finally {
      this.busy = false
    }
    return this.status
  }

  /** Stop what is running, then hand over to the installer. Only once a version is downloaded. */
  async install(): Promise<boolean> {
    const { backend } = this
    // A backend that only looks never reaches `ready`.
    if (!backend || isManual(backend) || this.status.state !== 'ready') return false
    this.log(`installing update ${this.status.version ?? ''}`)
    await this.beforeInstall()
    backend.install()
    return true
  }
}
