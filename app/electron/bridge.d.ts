/** The small typed API the preload exposes to the renderer as `window.openstems`. */

export type EngineStatus =
  | { state: 'starting'; detail: string }
  | { state: 'ready'; baseUrl: string; token: string }
  | { state: 'failed'; error: string }

/**
 * Which PyTorch build the engine environment holds: NVIDIA (CUDA 13.0), NVIDIA for older
 * cards (CUDA 12.6), AMD (ROCm), or Apple Silicon (MPS, the only build on a Mac).
 */
export type TorchVariant = 'cuda' | 'cu126' | 'rocm' | 'mps'

export interface SetupStatus {
  /** `ready` means the Python environment exists; `needed` means first-run setup must run. */
  state: 'ready' | 'needed' | 'running' | 'failed'
  log: string[]
  error?: string
  /**
   * The running setup is the short one after an app update: the environment exists and only
   * what changed is installed. It starts by itself and needs nothing from the user.
   */
  updating?: boolean
  /** False in development, where the engine runs from the source tree and is never set up here. */
  managed: boolean
  /** The build setup installs next: the installed one, else the recommended one. */
  variant: TorchVariant
  /** The build in the environment on disk, once a setup has finished. */
  installed: TorchVariant | null
  /**
   * The builds this machine can choose from. One entry (a Mac) means there is nothing to
   * choose. Absent means the three Windows builds.
   */
  variants?: TorchVariant[]
  /** The video adapters were looked at; `gpus`, `note` and `recommended` are filled in. */
  detected: boolean
  recommended?: TorchVariant
  gpus: string[]
  /** One sentence about what was found and what it means. */
  note: string
  /** Set when setup cannot work on this machine (an Intel Mac): the reason, in a sentence. */
  unsupported?: string
}

/**
 * How the app behaves as a desktop program: the tray (on a Mac, the menu bar item) and
 * starting at login.
 */
export interface ShellStatus {
  /**
   * Closing the window leaves the app in the tray instead of quitting. Windows only: a Mac
   * app always stays open without its window, so the switch does nothing there.
   */
  closeToTray: boolean
  /** Look for a new version by itself, a few times a day. */
  checkForUpdates: boolean
  /** A system notification when songs finish while the app is out of sight. */
  notifyReady: boolean
  /** Light, dark, or whatever the system uses (`system`, which follows it live). */
  theme: 'system' | 'light' | 'dark'
  /** The app starts at login, in the tray, with no window. */
  startAtLogin: boolean
  /** False in development: only an installed app can register itself to start at login. */
  canStartAtLogin: boolean
}

/*
 * Two things reach the page of the full window on a Mac without going through the bridge:
 *
 * - The CSS variable `--traffic-lights-inset` on the root element: the width the title bar
 *   must leave free on its left for the close, minimize and zoom buttons. It is `80px` in a
 *   window, `0px` in full screen, where macOS hides the buttons, and not set at all on
 *   Windows or in the quick-drop window.
 * - The DOM event `openstems:settings` on `window`, when Settings is picked from the
 *   application menu (Cmd+,).
 */

export type { TrayActivity } from './traylogic'

/** Self-update: where the app is between "nothing new" and "restart into the new version". */
export interface UpdateStatus {
  /**
   * `idle`: nothing newer is known. `available`: `version` can be downloaded. `downloading`:
   * `progress` runs from 0 to 1. `ready`: downloaded, a restart installs it.
   */
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready'
  /** The version that is running. */
  current: string
  /** The newer version, once one is known. */
  version?: string
  /**
   * The app cannot install `version` by itself (an unsigned Mac app). "Download" opens `url`
   * in the browser instead, and the state stays `available`: there is no progress and no
   * restart. The button should say where it leads, such as "Get 0.3.0".
   */
  manual?: boolean
  /** The release page a manual update opens. */
  url?: string
  progress?: number
  /** When the last successful check finished, in milliseconds since the epoch. */
  checkedAt?: number
  /** Something the user asked for did not work, in a sentence. */
  error?: string
  /** False in development: only an installed app can update itself. */
  supported: boolean
}

export interface OpenStemsBridge {
  /** Current engine status. */
  engine(): Promise<EngineStatus>
  /** Subscribe to engine status changes. Returns an unsubscribe function. */
  onEngineStatus(listener: (status: EngineStatus) => void): () => void
  restartEngine(): Promise<void>
  /** First-run setup of the Python environment (packaged builds). */
  setup(): Promise<SetupStatus>
  /** Look at the video adapters (once) and return the status with the recommendation. */
  detectGpu(): Promise<SetupStatus>
  /** Run first-run setup, for the given build or the current selection. */
  runSetup(variant?: TorchVariant): Promise<void>
  /** Stop the engine, rebuild its environment with another build, start it again. */
  switchBuild(variant: TorchVariant): Promise<void>
  onSetupStatus(listener: (status: SetupStatus) => void): () => void
  /** Real file-system paths of dropped or picked files. */
  pathsForFiles(files: File[]): string[]
  /** Start a native drag of one or more files out of the window. */
  startDrag(paths: string[]): void
  /** The text on the clipboard, for pasting a link with a button. */
  clipboardText(): Promise<string>
  revealInExplorer(path: string): Promise<void>
  openFolder(path: string): Promise<void>
  pickFolder(defaultPath?: string): Promise<string | null>
  pickFile(options: { title: string; extensions: string[] }): Promise<string | null>
  /** Bring the full app to the front, opening its window if it was closed to the tray. */
  showMain(): Promise<void>
  /** Hide the quick-drop window. `viaKeyboard` returns focus to the notification area. */
  hidePopup(viaKeyboard?: boolean): void
  /** The quick-drop window tells the tray icon what the queue is doing. */
  reportActivity(activity: import('./traylogic').TrayActivity): void
  shellStatus(): Promise<ShellStatus>
  setShell(patch: Partial<Pick<ShellStatus, 'closeToTray' | 'startAtLogin' | 'checkForUpdates' | 'notifyReady' | 'theme'>>): Promise<ShellStatus>
  /** Self-update. */
  updates(): Promise<UpdateStatus>
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  checkForUpdates(): Promise<UpdateStatus>
  downloadUpdate(): Promise<UpdateStatus>
  /**
   * Restart into the downloaded version. With jobs queued or running it does nothing and
   * says how many, unless `force` is set.
   */
  installUpdate(force?: boolean): Promise<{ started: boolean; activeJobs: number }>
  info: { version: string; platform: string; e2e: boolean }
}

declare global {
  interface Window {
    openstems: OpenStemsBridge
  }
}
