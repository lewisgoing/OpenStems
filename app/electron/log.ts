import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logsDir as logsDirFor } from './platform'

const MAX_BYTES = 1_000_000

/** The logs folder, shared with the engine (engine.log) and read by Export diagnostics. */
export function logsDir(): string {
  return logsDirFor({ platform: process.platform, home: homedir(), env: process.env })
}

/** Append one line to app.log. Logging never throws. */
export function log(message: string): void {
  try {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'app.log')
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, join(dir, 'app.log.1'))
    } catch {
      // No log file yet.
    }
    appendFileSync(file, `${new Date().toISOString()} ${message.replace(/\r?\n/g, ' | ')}\n`, 'utf8')
  } catch {
    // A full disk or a locked file must not take the app down.
  }
}
