/**
 * Where things live and what they are called on each system. Pure logic: the platform, the
 * home folder and the environment are passed in, so the unit tests can ask for macOS answers
 * on Windows. No Node or Electron imports, so the unit tests can load it.
 *
 *   Windows  %LOCALAPPDATA%\OpenStems (engine-env, logs, models, cache)
 *   macOS    ~/Library/Application Support/OpenStems (engine-env, models, settings),
 *            ~/Library/Logs/OpenStems
 *
 * The engine decides the same folders for itself in `openstems/settings.py`: change both
 * together.
 */
export const APP_NAME = 'OpenStems'

/** What the folder functions need to know about the machine. */
export interface Host {
  /** `process.platform`: 'win32', 'darwin', ... */
  platform: string
  home: string
  env: Record<string, string | undefined>
}

/**
 * Join path parts the way `platform` writes paths, whatever system this runs on. For the
 * absolute folders used here it gives what `path.join` gives on that system: one separator
 * between parts, backslashes on Windows.
 */
export function joinPath(platform: string, ...parts: string[]): string {
  if (platform !== 'win32') return parts.join('/').replace(/\/{2,}/g, '/')
  const joined = parts.join('\\').replace(/\//g, '\\')
  // A network path keeps its two leading backslashes.
  return joined.slice(0, 2) + joined.slice(2).replace(/\\{2,}/g, '\\')
}

/** The folder that holds the engine's environment, and on Windows the logs as well. */
export function dataRoot(host: Host): string {
  if (host.platform === 'darwin') return joinPath('darwin', host.home, 'Library', 'Application Support', APP_NAME)
  // Windows. Other systems keep what they had: the same layout under the home folder.
  const local = host.env.LOCALAPPDATA ?? joinPath(host.platform, host.home, 'AppData', 'Local')
  return joinPath(host.platform, local, APP_NAME)
}

/** The Python environment created on first run (packaged builds only). */
export function engineEnvDir(host: Host): string {
  return joinPath(host.platform, dataRoot(host), 'engine-env')
}

/** The logs folder, shared with the engine (engine.log) and read by Export diagnostics. */
export function logsDir(host: Host): string {
  if (host.platform === 'darwin') return joinPath('darwin', host.home, 'Library', 'Logs', APP_NAME)
  return joinPath(host.platform, dataRoot(host), 'logs')
}

/** A program inside a Python environment: `Scripts\name.exe` on Windows, `bin/name` elsewhere. */
export function venvExecutable(envDir: string, name: string, platform: string): string {
  return platform === 'win32' ? joinPath(platform, envDir, 'Scripts', `${name}.exe`) : joinPath(platform, envDir, 'bin', name)
}

/** The file name of the uv that ships in the app's `resources/bin`. */
export function uvFileName(platform: string): string {
  return platform === 'win32' ? 'uv.exe' : 'uv'
}

/**
 * Extra `uv venv` arguments at first-run setup. On a Mac only uv's own Python is used: one
 * from Homebrew would change under the environment. Windows asks for nothing extra.
 */
export function venvArgs(platform: string): string[] {
  return platform === 'darwin' ? ['--managed-python'] : []
}

/**
 * Extra environment for `uv pip install` at setup. Windows copies files out of uv's cache.
 * A Mac keeps uv's default, which clones them.
 */
export function installEnv(platform: string): Record<string, string> {
  return platform === 'win32' ? { UV_LINK_MODE: 'copy' } : {}
}

/**
 * The app bundle a Mac executable runs from: `/Applications/OpenStems.app` for
 * `/Applications/OpenStems.app/Contents/MacOS/OpenStems`, three levels up.
 */
export function macBundlePath(exe: string): string {
  return exe.split('/').slice(0, -3).join('/')
}

/**
 * Extra `uv run` arguments in development. The project's default groups hold the NVIDIA
 * PyTorch, which has no macOS build: a Mac asks for the `mps` group instead.
 */
export function devGroupArgs(platform: string): string[] {
  return platform === 'darwin' ? ['--no-default-groups', '--group', 'dev', '--group', 'mps'] : []
}
