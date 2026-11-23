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

const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

type Listener = (status: UpdateStatus) => void

interface UpdaterOptions {
  /** The version that is running. */
  current: string
  /** Null where the app cannot update itself (development). */
  backend: UpdateBackend | null
  /** Runs before the installer takes over: everything of the app's must have stopped. */
  beforeInstall: () => Promise<void>
  log?: (message: string) => void
}

/**
 * Self-update: look for a newer release, download it when the user says so, then restart
 * into it. One state at a time, sent to every window. Nothing is downloaded or installed
 * unless the user asked for it.
 */
export class Updater {
  status: UpdateStatus
  private readonly backend: UpdateBackend | null
  private readonly beforeInstall: () => Promise<void>
  private readonly log: (message: string) => void
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false

  constructor(options: UpdaterOptions) {
    this.backend = options.backend
    this.beforeInstall = options.beforeInstall
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
      if (version) this.set({ state: 'available', version, checkedAt: Date.now() })
      else this.set({ state: 'idle', version: undefined, checkedAt: Date.now() })
    } catch (error) {
      this.log(`update check failed: ${error instanceof Error ? error.message : String(error)}`)
      // No network is the usual reason. A check the app made by itself stays quiet about it.
      this.set({
        state: known ? 'available' : 'idle',
        version: known,
        error: manual ? 'Could not check for updates. Is this PC online?' : undefined,
      })
    } finally {
      this.busy = false
    }
    return this.status
  }

  async download(): Promise<UpdateStatus> {
    const { backend } = this
    if (!backend || this.busy || this.status.state !== 'available') return this.status
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

  /** Stop what is running, then hand over to the installer. Only once a version is downloaded. */
  async install(): Promise<boolean> {
    if (!this.backend || this.status.state !== 'ready') return false
    this.log(`installing update ${this.status.version ?? ''}`)
    await this.beforeInstall()
    this.backend.install()
    return true
  }
}
