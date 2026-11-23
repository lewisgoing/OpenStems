import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SetupStatus } from './bridge'
import { bundledUv, engineEnvDir, engineExecutable, engineInstalled, engineSourceDir, envExecutable } from './engine'
import { installEnv, venvArgs } from './platform'
import {
  type GpuAdapter,
  type TorchVariant,
  adaptersFromVendorIds,
  defaultVariant,
  formatMarker,
  isVariant,
  parseAdapters,
  parseMarker,
  recommendVariant,
  setupRefusal,
  unsupportedReason,
  variantsFor,
} from './variant'

type Listener = (status: SetupStatus) => void

const PYTHON_VERSION = '3.12'
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu130'

/** Per build: the pinned requirements file and where PyTorch comes from. */
const VARIANTS: Record<TorchVariant, { requirements: string; indexArgs: string[]; what: string }> = {
  cuda: {
    requirements: 'requirements.txt',
    // PyTorch for CUDA 13.0 is the large download (about 3 GB).
    indexArgs: ['--extra-index-url', TORCH_INDEX, '--index-strategy', 'unsafe-best-match'],
    what: 'PyTorch for NVIDIA GPUs',
  },
  cu126: {
    // The same PyTorch for CUDA 12.6, the last build that carries GTX 900 and 10 series cards.
    requirements: 'requirements-cu126.txt',
    indexArgs: ['--extra-index-url', 'https://download.pytorch.org/whl/cu126', '--index-strategy', 'unsafe-best-match'],
    what: 'PyTorch for older NVIDIA GPUs',
  },
  rocm: {
    // AMD's build and its ROCm runtime are direct, hash-pinned links to repo.radeon.com.
    requirements: 'requirements-rocm.txt',
    indexArgs: [],
    what: 'PyTorch for AMD Radeon GPUs',
  },
  mps: {
    // Apple Silicon: PyTorch comes from PyPI like everything else, so no extra index.
    requirements: 'requirements-mps.txt',
    indexArgs: [],
    what: 'PyTorch for Apple Silicon',
  },
}

/**
 * Ask Windows for its video adapters. Falls back to Chromium's list, then to nothing.
 * A Mac is not asked: it has one build, whatever its adapters are called.
 */
export async function detectAdapters(): Promise<GpuAdapter[]> {
  if (process.platform === 'darwin') return []
  if (process.platform === 'win32') {
    const json = await new Promise<string>((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID | ConvertTo-Json -Compress',
        ],
        { windowsHide: true, timeout: 8000 },
        (error, stdout) => resolve(error ? '' : stdout),
      )
    })
    const adapters = parseAdapters(json)
    if (adapters.length > 0) return adapters
  }
  try {
    const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId: number }[] }
    return adaptersFromVendorIds(info.gpuDevice ?? [])
  } catch {
    return []
  }
}

/**
 * First-run setup for packaged builds: create the Python environment with the bundled uv,
 * install the pinned requirements for this machine's GPU vendor, then run the doctor check.
 *
 * The environment lives in the user's profile, outside the install folder, next to the
 * models folder. After an app update it is not rebuilt: `refresh` installs what changed
 * (usually only the app's own small package) into the environment that is there.
 */
export class EngineSetup {
  status: SetupStatus
  private listeners = new Set<Listener>()
  private detecting: Promise<void> | null = null

  constructor() {
    const installed = this.installedVariant()
    this.status = {
      state: this.upToDate() ? 'ready' : 'needed',
      log: [],
      managed: app.isPackaged && !process.env.OPENSTEMS_ENGINE_CMD,
      variant: installed ?? defaultVariant(process.platform),
      installed,
      variants: variantsFor(process.platform),
      detected: false,
      gpus: [],
      note: '',
      unsupported: unsupportedReason(process.platform, process.arch) ?? undefined,
    }
  }

  onStatus(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private marker(): string {
    return join(engineEnvDir(), '.openstems-version')
  }

  private readMarker(): { version: string; variant: TorchVariant } | null {
    try {
      return parseMarker(readFileSync(this.marker(), 'utf8'), process.platform)
    } catch {
      return null
    }
  }

  /** The build in the environment on disk, when setup has completed there. */
  private installedVariant(): TorchVariant | null {
    if (!app.isPackaged || !engineInstalled()) return null
    return this.readMarker()?.variant ?? null
  }

  /** The environment exists and was built for this app version. */
  private upToDate(): boolean {
    if (!engineInstalled()) return false
    if (!app.isPackaged || process.env.OPENSTEMS_ENGINE_CMD) return true
    return this.readMarker()?.version === app.getVersion()
  }

  private set(patch: Partial<SetupStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const listener of this.listeners) listener(this.status)
  }

  private log(line: string): void {
    this.set({ log: [...this.status.log, line].slice(-200) })
  }

  /**
   * Look at the video adapters and recommend a build. Runs once; safe to call again.
   * An installed build is kept as the selection: detection never switches it by itself.
   */
  detect(): Promise<void> {
    this.detecting ??= (async () => {
      const adapters = await detectAdapters()
      const choice = recommendVariant(adapters, { platform: process.platform, arch: process.arch })
      const forced = process.env.OPENSTEMS_TORCH_VARIANT
      const offered = variantsFor(process.platform)
      // An environment built for a build this system does not offer is not kept.
      const installed = this.status.installed && offered.includes(this.status.installed) ? this.status.installed : null
      this.set({
        detected: true,
        gpus: adapters.map((a) => a.name),
        note: choice.note,
        recommended: choice.variant,
        variant: isVariant(forced) && offered.includes(forced) ? forced : (installed ?? choice.variant),
      })
    })()
    return this.detecting
  }

  private run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log(`> ${[command.split(/[\\/]/).pop(), ...args].join(' ')}`)
      const child = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const onData = (chunk: string) => {
        for (const line of chunk.split(/\r?\n|\r/)) if (line.trim()) this.log(line.trimEnd())
      }
      child.stdout.setEncoding('utf8').on('data', onData)
      child.stderr.setEncoding('utf8').on('data', onData)
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit code ${code}`))))
    })
  }

  /** Install the pinned requirements of a build into the environment. uv skips what is already there. */
  private install(variant: TorchVariant): Promise<void> {
    const source = engineSourceDir()
    const spec = VARIANTS[variant]
    return this.run(
      bundledUv(),
      [
        'pip',
        'install',
        '--python',
        envExecutable('python'),
        '--no-deps',
        '--requirement',
        join(source, spec.requirements),
        '--find-links',
        join(source, 'wheels'),
        ...spec.indexArgs,
      ],
      installEnv(process.platform),
    )
  }

  /**
   * After an app update: the environment was built by an earlier version, for a known build.
   * Then nothing has to be rebuilt and the user has nothing to decide.
   */
  canRefresh(): boolean {
    return (
      this.status.managed &&
      this.status.state === 'needed' &&
      this.installedVariant() !== null &&
      existsSync(envExecutable('python')) &&
      existsSync(join(engineSourceDir(), VARIANTS[this.installedVariant() ?? defaultVariant(process.platform)].requirements))
    )
  }

  /**
   * Bring the existing environment up to this app version: install the pinned requirements
   * over it. Every pin that is already satisfied is skipped, so this is seconds, not the
   * minutes and gigabytes of a first setup. If it fails, the full setup is offered instead.
   */
  async refresh(): Promise<void> {
    const variant = this.installedVariant()
    if (!variant || this.status.state === 'running') return
    this.set({ state: 'running', updating: true, log: [], error: undefined, variant })
    try {
      this.log(`Updating the engine for OpenStems ${app.getVersion()}`)
      await this.install(variant)
      writeFileSync(this.marker(), formatMarker(app.getVersion(), variant), 'utf8')
      this.set({ state: 'ready', updating: false, installed: variant })
    } catch (error) {
      this.log(`The quick update did not work: ${error instanceof Error ? error.message : String(error)}`)
      this.set({ state: 'needed', updating: false })
    }
  }

  /** Build the environment for `variant` (default: the current selection). */
  async runSetup(variant?: TorchVariant): Promise<void> {
    if (this.status.state === 'running') return
    await this.detect()
    const chosen = variant ?? this.status.variant
    const spec = VARIANTS[chosen]
    const refused = setupRefusal(chosen, process.platform, process.arch)
    if (refused) {
      this.set({ state: 'failed', log: [], error: refused })
      return
    }
    this.set({ state: 'running', log: [], error: undefined, variant: chosen })
    const envDir = engineEnvDir()
    const source = engineSourceDir()
    const requirements = join(source, spec.requirements)
    const uv = bundledUv()
    try {
      mkdirSync(join(envDir, '..'), { recursive: true })
      if (!existsSync(requirements)) throw new Error(`engine files are missing from ${source}`)

      // uv fetches its own Python, so nothing has to be installed on the machine first.
      this.log(`Creating the Python ${PYTHON_VERSION} environment`)
      await this.run(uv, ['venv', '--python', PYTHON_VERSION, ...venvArgs(process.platform), '--clear', envDir])
      this.set({ installed: null })

      // Every dependency is pinned; nothing is resolved on the user's machine.
      this.log(`Installing ${spec.what} and the model code`)
      await this.install(chosen)

      this.log('Checking the GPU')
      try {
        await this.run(engineExecutable(), ['doctor'], { PYTHONUTF8: '1', NO_COLOR: '1' })
      } catch {
        this.log('The doctor check reported a problem. The app still starts; see Settings.')
      }
      writeFileSync(this.marker(), formatMarker(app.getVersion(), chosen), 'utf8')
      this.set({ state: 'ready', installed: chosen })
    } catch (error) {
      this.set({ state: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
}
