import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A song's original drags out only in the formats the main process lets through: every one
// the engine takes, or a fetched .webm would be dropped without a word.
const extensions = (text: string) => new Set(text.match(/'\.[a-z0-9]+'|"\.[a-z0-9]+"/g)?.map((e) => e.slice(1, -1)))

describe('the formats a drag lets out', () => {
  it('hold every format the engine takes', () => {
    const root = join(__dirname, '..', '..')
    const main = readFileSync(join(root, 'electron', 'main.ts'), 'utf8')
    const draggable = extensions(main.slice(main.indexOf('const DRAGGABLE'), main.indexOf('])', main.indexOf('const DRAGGABLE'))))
    const engine = readFileSync(join(root, '..', 'engine', 'src', 'openstems', 'cli_inputs.py'), 'utf8')
    const taken = extensions(engine.slice(engine.indexOf('AUDIO_SUFFIXES = {'), engine.indexOf('}', engine.indexOf('AUDIO_SUFFIXES = {'))))
    expect(taken.size).toBeGreaterThan(10)
    for (const ext of taken) expect(draggable).toContain(ext)
    expect(draggable).toContain('.mid')
  })
})
