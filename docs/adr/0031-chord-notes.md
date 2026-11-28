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
  and `POST /v1/notes/model` download it into `<models>/basic-pitch/`; the app's button is
  Settings > Chords in MIDI, and `chord_model` in the system info says whether it is there.
  Nothing fetches it by itself, and a file there that is not this very file is not used.
  Without it a stem that plays chords gives one line, as before.
- **"Write MIDI" reads every pitched stem** (the owner's decision, 2026-11-27), where it read
  vocal, bass and melody stems: `EVERY_PITCHED` in `MIDI_STEMS`, which `readable` takes for
  every stem with a pitch to follow that is not empty. Drums and mixtures are still not
  read. The cache key holds the five names it always held, so no song is separated again;
  a cached song's other stems are read where they lie the next time it is asked for.

## Measured

Clean recordings, onset F1 (`scratch` lab of 2026-11-27, through `midi_bench.py`'s scoring):

| Set | Single line | Chord reader |
| --- | --- | --- |
| GuitarSet chords, 12 recordings | 0.332 | 0.737 |
| GuitarSet solos, 12 recordings | 0.870 | 0.853 |
| Slakh pianos, 12 test songs | 0.424 | 0.796 |
| Slakh guitars, 12 test songs | 0.383 | 0.590 |

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

- **Separated stems.** No separated piano or guitar stem has been read. A stand-in was:
  six Slakh pianos and six guitars through `read_stem`, with the rest of the song put back
  under the stem. Pianos read 0.736 clean, 0.651 with the rest 25 dB under and 0.601 at
  15 dB; guitars 0.589, 0.573 and 0.513. Recall holds (0.76 on pianos at every level) and
  precision falls (0.72, 0.59, 0.52): the chord reader writes down the bleed as notes. The
  plan's bleed pass across stems is what answers that, and it is not built. One guitar
  line was called chords at 15 dB and fell from 0.50 to 0.27.
- **Slakh's guitars are the weak set** (0.590): several guitars play in one stem there,
  and three songs read under 0.36.
- **The app's button** has been run by a component test and the FakeEngine's stand-in
  only: nobody has pressed it in the app, on either system.
- **Time.** A recipe with many pitched stems now has each of them read. How long that adds
  to a run has not been measured.
- **A Mac.** The unit tests run in CI on `macos-15` without the model file. The model has
  not been run on a Mac by anyone.
- **Piano with Kong's model, guitar with a specialist**, and anything the app trains itself.
