import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { log } from './log'
import { type ShellPrefs, parsePrefs } from './traylogic'

/** The shell's own preferences, in `shell.json` beside the rest of the app's data. */
export class Prefs {
  private readonly file = join(app.getPath('userData'), 'shell.json')
  value: ShellPrefs

  constructor() {
    let text: string | null = null
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      // First run: the defaults apply.
    }
    this.value = parsePrefs(text)
  }

  update(patch: Partial<ShellPrefs>): ShellPrefs {
    this.value = { ...this.value, ...patch }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8')
    } catch (error) {
      log(`could not save shell.json: ${String(error)}`)
    }
    return this.value
  }
}
