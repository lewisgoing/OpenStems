# 0028: Notes of single-line stems (stem to MIDI, stage M3)

Date: 2026-11-25. Status: accepted. Phase 7 of `PLAN.md`, stage M3 of
`docs/research/stem-to-midi.md`, with four deviations from that plan.

## Context

"Write MIDI" wrote a `.mid` beside vocal, bass and melody stems from a YIN pitch tracker. On
the benchmark's clean stems it scored 0.39 onset F1 on vocals and 0.32 on guitar solos, with
798 octave errors on the guitars. The plan's stage M3 replaces it for stems that play one
note at a time, and the editor designed for it (the Studio prototype) needs more than notes:
a confidence on each, the notes that were nearly found, and a file that holds them.

## Decision

`audio/transcribe.py` reads a single-line stem (`transcribe_line`), and `pipeline/notes.py`
writes what it finds.

- **Pitch:** SwiftF0 (ONNX, on the CPU) every 16 ms.
- **Notes:** the dynamic program of SwiftF0's own segmenter, ported into the engine (MIT,
  the notice is in the module), with one term added: on a plucked line a note that is struck
  again while it sounds ends there. A test holds the port to SwiftF0's own output.
- **Low bass:** SwiftF0 reports nothing under 46.9 Hz. A bass is tracked a second time at
  double speed, where every pitch is an octave up, and the frames that pass finds under
  58 Hz replace the first pass's. That reaches 23 Hz, under a 5-string's low B.
- **Starts:** a bass note's start moves back to where its level rises fastest. A pitch
  takes a few periods to settle, and on Slakh's basses the pitch alone came 25 ms late.
- **Three profiles** by the stem's name (`domain/notes.line_kind`): `voice` (no splitting at
  onsets, starts left where the pitch starts), `bass`, and `line` for every other pitched
  stem. Drums and mixtures are not read.
- **Candidates and confidence:** a second, more willing pass finds notes the first left out.
  Every note, sure or not, gets a confidence from a logistic model over ten numbers (what it
  cost the segmenter, its length, level, pitch spread and neighbours), fitted per profile by
  `scripts/midi_calibrate.py`. A profile's `threshold` is the confidence at which showing a
  note gave the best F1.
- **Chords:** a stem over whose louder frames SwiftF0 is unsure of any pitch (`clarity`
  under 0.78) is marked `chords`. It is still read, as one line, and the job says so.
- **Two files beside the stem:** `<stem>.notes.json` holds every note with its confidence,
  the threshold, the tuning and the texture; `<stem>.mid` holds the notes at or above the
  threshold, as plain notes in one track (format 0) on the song's tempo and key. A stem in
  which nothing was found gets the notes file alone.
- **Keys:** at A440, unless a stem with fixed pitches (not a voice) agrees on another tuning
  with a strength of 0.7 or more; then every MIDI file of the song is rounded against that.
- **Afterwards:** `POST /v1/notes` reads stems that are already written. A retag writes each
  MIDI file again from its notes file, since a MIDI file counts in beats. A rename takes
  both files along. A song that comes from the cache with the old tracker's MIDI (a MIDI
  file and no notes file) has those stems read again where they lie, without separating it
  again.
- **Which stems by default:** the same as before, by kind: voices, basses and `melody`
  (`MIDI_STEMS`). Any other pitched stem is read when asked for.

## Deviations from the plan

1. **The segmenter is SwiftF0's, not an HMM written from the Tony paper.** M0 measured it
   at 0.78 on vocals against 0.50 for the engine's old segmentation of the same frames, level
   with a second human annotator (0.74). The Tony HMM stays the fallback the plan named.
2. **Low bass is a second SwiftF0 pass, not torchcrepe or pYIN.** torchcrepe's lowest bin is
   31.7 Hz, above low B, and its default floor is 50 Hz. The double-speed pass needs no
   second model and tracked test tones from 30.9 Hz up exactly.
3. **SwiftF0's model is not in the catalog.** Ground rule 6 has checkpoints downloaded from
   catalog URLs and verified by sha256. This one is a 135 KB ONNX file inside the `swift-f0`
   wheel, pinned in `pyproject.toml` and verified by the hash in `uv.lock` (and in the
   packaged app's requirements files). It is not a pickle, so loading it runs no code.
4. **Pitch bends are written by the MIDI writer but not offered yet.** The stem's own file
   is plain notes. The bend and MPE modes of `midi_file_bytes` wait for the editor (M5) and
   for the owner's import test in FL Studio.

## What was measured, and what was not

On clean recordings, by `scripts/midi_bench.py` (onset F1, mir_eval's 50 ms and 50 cents):

| Stem | Old tracker | SwiftF0's segmenter alone | This transcriber | Clips |
| --- | --- | --- | --- | --- |
| Vocals (vocadito) | 0.392 | 0.778 | 0.784 | 40 |
| Guitar solos (GuitarSet) | 0.324 | 0.801 | 0.849 | 180 |

Bass, low bass, the held-out figures and how far the confidence can be trusted are in
`docs/research/stem-to-midi.md`, section 14.

- **Not measured on separated stems.** Every figure is from clean audio. Separated stems
  carry bleed and artifacts, the profiles' thresholds and weights were fitted without them,
  and Phase 7's acceptance asks for separated stems. That run needs the GPU.
- **A voice's confidence ranks weakly** (AUC 0.73 on held-out clips, 0.87 for guitar lines):
  most of its "wrong" notes are short ornaments one annotator wrote down and the other did
  not.
- **Chords** are one line of what is played until stage M4.

## Consequences

- `swift-f0` 0.3.0 and `onnxruntime` 1.32.0 are dependencies of every build. onnxruntime's
  Apple Silicon wheel needs macOS 14, the app's own floor.
- A 6-minute stem takes about 2 seconds on two CPU threads. Nothing runs on the GPU, so
  there is no memory to plan for and no MPS path to verify.
- Stems separated before this version keep their old MIDI until the song is queued again
  with "Write MIDI" on (it comes from the cache and is read again) or they are read through
  `POST /v1/notes`.
- The API process may transcribe: the module imports no torch.
- Windows and a Mac run the same code. The tests run on both in CI; nothing here has been
  seen on a Mac.
