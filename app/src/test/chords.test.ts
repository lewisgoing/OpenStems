import { describe, expect, it } from 'vitest'
import { writeMidiHint } from '@/views/SettingsView'

describe('what Write MIDI says it gives', () => {
  it('names every pitched stem, on both systems alike', () => {
    for (const chords of [true, false]) {
      expect(writeMidiHint(chords)).toContain('every stem with notes to read')
      expect(writeMidiHint(chords)).toContain('not drums')
    }
  })

  it('says one line of a chord until the chord model is there', () => {
    expect(writeMidiHint(false)).toContain('one line of them')
    expect(writeMidiHint(false)).toContain('chord model below')
    expect(writeMidiHint(true)).toContain('every note of them')
    expect(writeMidiHint(true)).not.toContain('one line')
  })
})
