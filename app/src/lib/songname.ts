// What the user may type for a song's name. The engine checks the same things
// (`clean_name` in engine/src/openstems/domain/naming.py), and both are tested against
// engine/tests/fixtures/song_names.json: change both together.

import type { Typed } from './tempokey'

/** The longest name, in characters: a folder name has to hold it. */
export const MAX_NAME = 120

/**
 * A song's name as typed. Empty means "the file's own name". Characters a file name cannot
 * hold stay in the name: the engine replaces them where the name is a folder or a file.
 */
export function cleanName(text: string): Typed<string> {
  const name = text
    .normalize('NFC')
    // A pasted line break or tab is a space.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return { ok: true, value: null }
  // Counted as the engine counts: an emoji is one character, not two.
  if ([...name].length > MAX_NAME) return { ok: false, error: `A name can be up to ${MAX_NAME} characters.` }
  if (!name.replace(/[ .]/g, '')) return { ok: false, error: 'A name needs more than dots.' }
  return { ok: true, value: name }
}

/** A song's file without its folder and extension: the name it goes by until it is given one. */
export function fileStem(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}
