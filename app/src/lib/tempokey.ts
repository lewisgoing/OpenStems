// What the user may type for a song's tempo and key. The engine checks the same things
// (`clean_bpm` and `clean_key` in engine/src/openstems/pipeline/retag.py): change both together.

export type Typed<T> = { ok: true; value: T | null } | { ok: false; error: string }

/** A tempo as typed. Empty means "none". */
export function parseBpm(text: string): Typed<number> {
  const trimmed = text.trim().replace(',', '.')
  if (!trimmed) return { ok: true, value: null }
  const bpm = Number(trimmed)
  if (!Number.isFinite(bpm)) return { ok: false, error: 'The tempo must be a number.' }
  if (bpm < 20 || bpm > 999) return { ok: false, error: 'The tempo must be between 20 and 999 BPM.' }
  return { ok: true, value: Math.round(bpm * 100) / 100 }
}

const FLATS: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E' }

/** A key as typed: C, F#, Bb or Am. A flat becomes the sharp that sounds the same. Empty means "none". */
export function parseKey(text: string): Typed<string> {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: null }
  const match = /^([A-Ga-g])([#b]?)(m?)$/.exec(trimmed)
  if (!match) return { ok: false, error: 'The key must look like C, F#, Bb or Am.' }
  const note = (match[1] ?? '').toUpperCase() + (match[2] ?? '')
  return { ok: true, value: (FLATS[note] ?? note) + (match[3] ?? '') }
}

/** A tempo for a small field: whole when it is whole, else up to two decimals. */
export function formatBpm(bpm: number | null | undefined): string {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm)) return ''
  return String(Math.round(bpm * 100) / 100)
}

/** The tempo and key in a job's or a stem set's `analysis`, or in a job's options. */
export function tempoKeyOf(record: Record<string, unknown> | null | undefined): { bpm: number | null; key: string | null } {
  return {
    bpm: typeof record?.bpm === 'number' ? record.bpm : null,
    key: typeof record?.key === 'string' && record.key ? record.key : null,
  }
}
