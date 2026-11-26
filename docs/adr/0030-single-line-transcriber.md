# 0030: Notes of single-line stems (stem to MIDI, stage M3)

Date: 2026-11-25. Status: accepted. Phase 7 of `PLAN.md`, stage M3 of
`docs/research/stem-to-midi.md`, with the deviations listed below.

## Context

"Write MIDI" wrote a `.mid` beside vocal, bass and melody stems from a YIN pitch tracker. On
the benchmark's clean recordings it scored 0.39 onset F1 on vocals, 0.32 on guitar solos and
0.66 on bass. The plan's stage M3 replaces it for stems that play one note at a time. The
note editor planned as stage M5 needs more than notes: a confidence on each, the notes that
were nearly found, and a file that holds them.

## Decision

`audio/transcribe.py` reads a single-line stem (`transcribe_line`), and `pipeline/notes.py`
writes what it finds.

- **Pitch:** SwiftF0 (ONNX, on the CPU) every 16 ms, asked only for pitches a profile's
  instrument plays.
- **Notes:** the dynamic program of SwiftF0's own segmenter, ported into the engine (MIT,
  the notice is in the module), with one term added: on a plucked line a note that is struck
  again while it sounds ends there. A test holds the port to SwiftF0's own output.
- **Low bass:** SwiftF0 reports nothing under 46.9 Hz. A bass is tracked a second time at
  double speed, where every pitch is an octave up, and the frames that pass finds under
  58 Hz replace the first pass's.
- **Starts:** on a bass and on any other plucked line, a note's start moves back to where
  its level rises fastest. A pitch takes a few periods to settle, and on Slakh's basses the
  pitch alone came 25 ms late. A voice's starts are left where the pitch starts.
- **Three profiles** by the stem's name (`domain/notes.line_kind`): `voice`, `bass`, and
  `line` for every other pitched stem. Drums and mixtures are not read, and neither is a
  stem the app judges empty (ADR 0027).
- **Candidates and confidence:** a second, more willing pass finds notes the first left out.
  Every note, sure or not, gets a confidence from a logistic model over ten numbers (what it
  cost the segmenter, its length, level, pitch spread and neighbours), fitted per profile by
  `scripts/midi_calibrate.py`. A profile's `threshold` is the confidence at which showing a
  note gave the best F1.
- **Chords:** a stem over whose louder frames SwiftF0 is unsure of any pitch (`clarity`
  under 0.78) is marked `chords`. It is still read, as one line, and the job says so.
- **Two files beside the stem:** `<stem>.notes.json` holds every note with its confidence,
  the threshold, the tuning, the texture and what wrote it; `<stem>.mid` holds the notes at
  or above the threshold, as plain notes in one track (format 0) on the song's tempo and
  key. A stem in which no note counts gets the notes file and no MIDI file (up to 0.4.6 a
  MIDI file was written even when it was empty).
- **Keys:** at A440, unless a stem with fixed pitches (not a voice) agrees on another tuning
  with a strength of 0.7 or more and by 5 cents or more; then the MIDI files written in that
  run are rounded against it. A stem read later takes the tuning the song's notes files
  already use, or else its own.
- **Never in the way of a separation:** if reading a stem fails, the stems are written all
  the same and the job says which stem has no MIDI.
- **Afterwards:** `POST /v1/notes` reads stems that are already written (nothing in the app
  calls it yet). A retag writes each MIDI file again from its notes file, since a MIDI file
  counts in beats. A rename takes both files along.
- **The cache:** the names in a run's cache key are the five the setting named up to 0.4.6
  (`KEYED_MIDI_STEMS`), written as before, so a song separated then still comes from the
  cache. On a cache hit, a stem asked for that has no notes file, or whose notes another
  version of the transcriber wrote, is read where it lies (`Pipeline._with_notes`): the song
  is not separated again.
- **Which stems by default:** voices, basses and `melody` (`MIDI_STEMS`). By name that is
  the five from before (`vocals`, `dry vocals`, `lead`, `bass`, `melody`) and five more that
  other recipes use for the same parts: `lead vocals`, `lead-vocal`, `vocal`, `double-bass`
  and `tuba`. Any other pitched stem is read when asked for.

## Deviations from the plan

1. **The segmenter is SwiftF0's, not an HMM written from the Tony paper.** M0 measured it
   at 0.78 on vocals against 0.50 for the engine's old segmentation of the same frames, level
   with a second human annotator (0.74). The Tony HMM stays the fallback the plan named.
2. **Low bass is a second SwiftF0 pass, not torchcrepe or pYIN.** torchcrepe's lowest bin is
   31.7 Hz, above a 5-string's low B, and its default floor is 50 Hz. The double-speed pass
   needs no second model.
3. **SwiftF0's model is not in the catalog** (ground rule 6 has checkpoints downloaded from
   catalog URLs and verified by sha256). It is a 135 KB ONNX file inside the `swift-f0`
   wheel, pinned in `pyproject.toml`. `uv.lock` holds the wheel's hash, which development
   and CI check; the packaged app installs it by its pinned version only, as it does every
   package from PyPI (`prepare-package.mjs` exports without hashes). It is not a pickle, so
   loading it runs no code.
4. **Its credit is not shown in the app.** The plan wants a tier B model's training data
   and attribution shown with it in the catalog. SwiftF0 is tier B (MIT weights; trained on
   NSynth, PTDB-TUG, MIR-1K, MDB-stem-synth and synthetic speech) and has no catalog entry,
   so the Models view does not list it. The README's License section names it.
5. **The transcriber's version is in the notes file, not in the cache key.** The plan put
   it in `RunOptions.key_dict()`. A key that changes with the transcriber separates every
   cached song again to refresh a file that takes two seconds to write. The notes file
   records what wrote it (`method`), and a cached song whose notes say otherwise is read
   again. `METHOD` in `pipeline/notes.py` must change whenever the notes a stem gives
   change.
6. **Confidence and candidates are built here, not in M5,** because the transcriber has to
   produce them and the notes file has to hold them. The editor is still M5.
7. **The polyphony check marks a stem; it does not route it.** There is nowhere to route to
   until stage M4. Its rule is in `audio/transcribe.py`, not `domain/notes.py`, since it is
   read from SwiftF0's frames.
8. **Pitch bends are written by the MIDI writer but not offered.** A stem's own file is
   plain notes. The bend and MPE modes of `midi_file_bytes` wait for the editor and for the
   owner's import test in FL Studio.
9. **No self-test entry and no Mac check script.** The plan asks for both per model.
   Nothing here runs on the GPU, so the self-test (GPU against CPU) has nothing to compare,
   and `scripts/mac_check.sh` does not exist. The steps for a Mac are in ADR 0014.
10. **One branch holds M0's harness, M1 and M3.** `PLAN.md` asks for a pull request per
    stage. None is open yet.

## What was measured, and what was not

On clean recordings, by `scripts/midi_bench.py` (onset F1, mir_eval's 50 ms and 50 cents; the
transcriber's notes at their exact pitch):

| Stem | Old tracker | SwiftF0's segmenter alone | This transcriber | Clips |
| --- | --- | --- | --- | --- |
| Vocals (vocadito) | VOC_OLD | VOC_SEG | VOC_NEW | 40 |
| Guitar solos (GuitarSet) | GTR_OLD | GTR_SEG | GTR_NEW | 180 |
| Bass (Slakh's own stems) | BASS_OLD | BASS_SEG | BASS_NEW | 142 |

Those are every clip of each set, and the settings and weights were fitted on every other
one. On the half nothing was fitted on: HELD_VOICE, HELD_LINE and HELD_BASS. The rest (low
bass, how far the confidence can be trusted, chords, tuning, velocity) is in
`docs/research/stem-to-midi.md`, section 14.

- **Not measured on separated stems.** Every figure is from clean audio. Separated stems
  carry bleed and artifacts, the thresholds and weights were fitted without them, and Phase
  7's acceptance asks for separated stems. That run needs the GPU. The transcriber was run
  on the separated stems of the project's three test songs as a check that it behaves; there
  is no reference to score those against.
- **Low notes rest on two things:** steady test tones down to 30.9 Hz (a 5-string's low B),
  which the double-speed pass follows, and Slakh's bass played 7 semitones lower, whose
  lowest note is 36.7 Hz. No real low bass was measured.
- **A voice's confidence ranks weakly** (AUC 0.73 on held-out clips, 0.87 for guitar lines):
  most of its "wrong" notes are short ornaments one annotator wrote down and the other did
  not.
- **Chords** are one line of what is played until stage M4.

## Consequences

- `swift-f0` 0.3.0, `onnxruntime` 1.32.0 and `soxr` are dependencies of every build.
  onnxruntime's Apple Silicon wheel needs macOS 14, the app's own floor.
- A stem of 6 minutes 26 seconds takes about 2 seconds on two CPU threads of the development
  PC. Nothing runs on the GPU, so there is no memory to plan for and no MPS path.
- A song separated before this version gets the new notes the next time it is queued with
  "Write MIDI" on, from the cache.
- The API process may transcribe: the module imports no torch.
- **A Mac:** the code is the same on both systems and nothing in it or its tests is
  Windows-only. No test of this change has run on a Mac: CI runs on pull requests and on
  `main`, and this branch has neither yet. onnxruntime's arm64 wheel going in through
  first-run setup has not been seen. ADR 0014 has the steps.
