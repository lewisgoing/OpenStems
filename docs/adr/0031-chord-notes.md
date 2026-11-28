# 0031: Notes of stems that play chords (stem to MIDI, stage M4, first step)

Date: 2026-11-27. Status: accepted as a first step. Phase 7 of `PLAN.md`, stage M4 of
`docs/research/stem-to-midi.md`, with the deviations listed below.

## Context

A stem that plays chords (a piano, a strummed guitar) was read as one line: the job said
"plays chords: its MIDI holds one line of them", and on GuitarSet's chord recordings the
single-line reader finds 0.33 of the notes (onset F1). The plan's stage M4 names Basic Pitch
(Spotify, Apache-2.0) as the instrument-agnostic model, with specialists for piano and
guitar after it.

## Decision

- **`audio/chords.py`** reads a stem with Basic Pitch's model and makes notes from its
  posteriors (`transcribe_chords`). The note maker is Basic Pitch's own method written anew,
  with the onset threshold at 0.6 for its 0.5.
- **`pipeline/notes.read_stem`** is what a run and "find notes" call. A stem is read as a
  line first, as before. When that reading says it plays chords (`texture`), its profile is
  `line` and the model is installed, its notes are every note the chord reader finds. A bass
  or a voice is never sent there: with the rest of a song loud under it, either is called
  chords too (ADR 0030).
- **The notes file** of such a stem names `CHORDS_METHOD` as its method, keeps `texture:
  chords`, and its threshold is the note maker's (0.3): every note found is shown. A note's
  confidence is the model's mean posterior over the note, and its velocity follows it.
  There are no bends and no candidates yet.
- **The model** is one file of 230 KB, `nmp.onnx` from Basic Pitch's 0.4.0 release, pinned
  by URL, size and sha256 in `pipeline/notes.CHORD_MODEL`. `openstems models pull-chords`
  downloads it into `<models>/basic-pitch/`. Nothing fetches it by itself, and a file there
  that is not this very file is not used. Without it everything is as before.

## Measured

Clean recordings, onset F1 (`scratch` lab of 2026-11-27, through `midi_bench.py`'s scoring):

| Set | Single line | Chord reader |
| --- | --- | --- |
| GuitarSet chords, 12 recordings | 0.332 | 0.737 |
| GuitarSet solos, 12 recordings | 0.870 | 0.853 |
| Slakh pianos, 12 test songs | 0.424 | 0.796 |

Through the code a run uses, the two chord recordings Melodyne was run on read 0.726 and
0.689 (Melodyne's Polyphonic Decay: 0.549 and 0.623), and a solo stays with the single-line
reader (0.903, Melodyne 0.886).

- Basic Pitch saw GuitarSet, MAESTRO, Slakh, iKala and MedleyDB in training. GuitarSet's
  figures are therefore not held out. The Slakh songs are from Slakh's test split.
- With offsets the pianos read 0.356: where notes end is weak.

## Deviations from the plan

1. **onnxruntime, not a PyTorch port.** The plan had the app port Basic Pitch to PyTorch and
   convert its weights. Basic Pitch's own release holds an ONNX file, and the engine already
   ships onnxruntime for SwiftF0. So there is no port, no conversion and no torch: the API
   process may read chords as it reads lines.
2. **Outside the catalog.** The catalog lists separation models, and the app shows it. This
   file is pinned in code and fetched by a command of its own. Rule 6 is kept in substance:
   a pinned address, a sha256 checked before use, and no pickle.
3. **No specialist, no bends, no bleed pass, no ghost pruning.** Stage M4 names them; this
   is the first step.

## Not done, not measured

- **Separated stems.** Every figure is from clean recordings. No separated piano or guitar
  stem has been read, and what bleed does to the chord reader is unknown.
- **Slakh guitars** were read for 9 of 12 songs before the PC ran short of memory; no mean
  is given.
- **The app** has no way to fetch the model: only the command line does. "Write MIDI"
  still reads vocal, bass and melody stems in a run (`MIDI_STEMS`); a piano or guitar stem
  is read when its notes are asked for.
- **A Mac.** The unit tests run in CI on `macos-15` without the model file. The model has
  not been run on a Mac by anyone.
- **Piano with Kong's model, guitar with a specialist**, and anything the app trains itself.
