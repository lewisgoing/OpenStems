import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'
import type { EngineStatus } from './bridge'

const HEALTH_TIMEOUT_MS = 90_000

export interface EngineCommand {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** In a packaged build: the pinned requirements and prebuilt wheels. In dev: the engine project. */
export function engineSourceDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'engine') : join(app.getAppPath(), '..', 'engine')
}

/** The Python environment created on first run (packaged builds only). */
export function engineEnvDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local')
  return join(local, 'OpenStems', 'engine-env')
}

export function engineExecutable(): string {
  return join(engineEnvDir(), 'Scripts', 'openstems.exe')
}

export function bundledUv(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin', 'uv.exe') : 'uv'
}

export function engineCommand(): EngineCommand {
  const serve = ['serve', '--parent-pid', String(process.pid)]
  if (process.env.OPENSTEMS_ENGINE_CMD) {
    // Test hook: a JSON array, e.g. ["python", "-m", "openstems.cli"].
    const [command, ...args] = JSON.parse(process.env.OPENSTEMS_ENGINE_CMD) as string[]
    return { command: command ?? 'openstems', args: [...args, ...serve] }
  }
  if (app.isPackaged) {
    return { command: engineExecutable(), args: serve }
  }
  const source = engineSourceDir()
  return { command: 'uv', args: ['run', '--project', source, 'openstems', ...serve], cwd: source }
}

export function engineInstalled(): boolean {
  return !app.isPackaged || Boolean(process.env.OPENSTEMS_ENGINE_CMD) || existsSync(engineExecutable())
}

type Listener = (status: EngineStatus) => void

/** Starts `openstems serve`, waits for its health check, and stops it on quit. */
export class EngineProcess {
  status: EngineStatus = { state: 'starting', detail: 'Starting the engine' }
  private child: ChildProcess | null = null
  private listeners = new Set<Listener>()
  private stopping = false
  private stderrTail: string[] = []
  /** Process id of the Python engine itself (the spawned child may be a launcher). */
  enginePid: number | null = null

  onStatus(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(status: EngineStatus): void {
    this.status = status
    for (const listener of this.listeners) listener(status)
  }

  start(): void {
    this.stopping = false
    this.stderrTail = []
    this.set({ state: 'starting', detail: 'Starting the engine' })
    const spec = engineCommand()
    let child: ChildProcess
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      this.set({ state: 'failed', error: `Could not start the engine: ${String(error)}` })
      return
    }
    this.child = child

    child.on('error', (error) => {
      if (this.child === child) this.set({ state: 'failed', error: `Could not start the engine: ${error.message}` })
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean))
      this.stderrTail = this.stderrTail.slice(-12)
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      if (!this.stopping) {
        const tail = this.stderrTail.slice(-4).join('\n')
        this.set({ state: 'failed', error: `The engine stopped (exit code ${code ?? 'unknown'}).${tail ? `\n${tail}` : ''}` })
      }
    })

    // The engine prints one JSON line with its port and token, then serves.
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      if (this.status.state === 'ready') return
      try {
        const message = JSON.parse(line) as { event?: string; port?: number; token?: string; pid?: number }
        if (message.event === 'listening' && message.port && message.token) {
          this.enginePid = message.pid ?? null
          void this.waitForHealth(child, `http://127.0.0.1:${message.port}`, message.token)
        }
      } catch {
        // Not JSON: ordinary log output.
      }
    })
  }

  private async waitForHealth(child: ChildProcess, baseUrl: string, token: string): Promise<void> {
    this.set({ state: 'starting', detail: 'Waiting for the engine' })
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (this.child === child && Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${token}` } })
        if (response.ok) {
          if (this.child === child) this.set({ state: 'ready', baseUrl, token })
          return
        }
      } catch {
        // Not accepting connections yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (this.child === child) this.set({ state: 'failed', error: 'The engine did not answer its health check.' })
  }

  /** Stop the engine and everything it started. Resolves once the process is gone. */
  stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.pid === undefined) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => resolve()
      child.once('exit', done)
      if (process.platform === 'win32') {
        // `uv run` puts Python in a child process: kill the whole tree.
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined)
      } else {
        child.kill('SIGTERM')
      }
      setTimeout(done, 4000)
    })
  }

  async restart(): Promise<void> {
    await this.stop()
    this.start()
  }
}
