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

### Reading a stem

- **Level:** every stem is read at one level: its peak, taken as its 32nd largest sample so
  that a click does not set it, is brought to 0.35. SwiftF0 calls a frame under a fixed
  level silent, so a quiet stem lost notes: read at a peak of 0.01, a guitar solo agreed
  with its own notes at its own level by only 0.62 to 0.90 (onset F1). A sample that is not
  a number, or lies far outside full scale, counts as silence.
- **Pitch:** SwiftF0 (ONNX, on the CPU) every 16 ms, asked only for pitches a profile's
  instrument plays.
- **Notes:** the dynamic program of SwiftF0's own segmenter, ported into the engine (MIT,
  the notice is in the module), with one rule added: on a plucked line a note that is struck
  again while it sounds ends there. Struck means an onset in the spectrum together with a
  rise of 3 dB in the stem's own level (`struck_again`): a drum that bled into the stem has
  the first without the second. A test holds the port to SwiftF0's own output.
- **Low bass:** SwiftF0 reports nothing under 46.9 Hz. A bass is tracked a second time at
  double speed, where every pitch is an octave up, and the frames that pass finds under
  58 Hz replace the first pass's.
- **Starts:** on a bass and on any other plucked line, a note's start moves back to where
  its level rises fastest. A pitch takes a few periods to settle, and on Slakh's basses the
  pitch alone came 28 ms late. A voice's starts are left where the pitch starts.
- **Three profiles** by the stem's name (`domain/notes.line_kind`): `voice`, `bass`, and
  `line` for every other pitched stem. Drums and mixtures are not read, and neither is a
  stem the app judges empty (ADR 0027).
- **Candidates and confidence:** a second, more willing pass finds notes the first left out.
  They never move a note of the first pass: each takes what is left of the gap it lies in.
  Every note, sure or not, gets a confidence from a logistic model over ten numbers (what it
  cost the segmenter, its length, level, pitch spread and neighbours), fitted per profile by
  `scripts/midi_calibrate.py`. A profile's `threshold` is the confidence at which showing a
  note gave the best F1.
- **Fitted with bleed:** the model is fitted on every other clip read three times: alone,
  and with the rest of a song 25 dB and 15 dB under it. A separated stem is not a clean one,
  and fitted on clean stems alone the model took a quiet note between a bass's own notes
  for a note. It is a stand-in until separated stems can be scored (below).
- **No second guess at a note's pitch** is written. SwiftF0 gives one pitch per frame, so
  the frames hold no evidence for another, and on the held-out clips an octave or two off is
  1 to 3 percent of the wrong notes: a "which octave?" question would nearly always be
  asked of a right note. Where one note ends and the next begins is the commoner fault:
  29 to 39 percent of the wrong notes are a piece cut out of a longer note, and 21 to 38
  percent of the missed ones were run into the note before them (section 14), so what the
  editor needs first is split and join. Its other questions can use what the file holds:
  the exact pitch and the tuning (a note between two keys), the confidence, the candidates.
- **Chords:** a stem over whose louder frames SwiftF0 is unsure of any pitch (`clarity`
  under 0.80) is marked `chords`. It is still read, as one line, and the job says so. The
  louder frames are counted among those within 20 dB of the stem's loud level, so silence or
  quiet bleed between phrases does not make a sparse line read as chords.

### Writing what was found

- **Two files beside the stem:** `<stem>.notes.json` holds every note with its confidence,
  the threshold, the tuning, the texture and what wrote it; `<stem>.mid` holds the notes at
  or above the threshold, as plain notes in one track (format 0) on the song's tempo and
  key. A stem in which no note counts gets the notes file and no MIDI file (up to 0.4.6 a
  MIDI file was written even when it was empty).
- **Keys:** at A440, unless a stem with fixed pitches (not a voice) agrees on another tuning
  with a strength of 0.7 or more and by 5 cents or more. One tuning holds for every MIDI
  file of a song, decided over every stem whose notes are known: when a stem read later
  settles another tuning, the MIDI files of the stems read before are rounded again from
  their notes files, so the order stems are read in does not matter.
- **Never in the way of a separation:** if reading a stem fails, the stems are written all
  the same and the job says which stem has no MIDI. A song from the cache whose notes cannot
  be written says why on its job, and its manifest stays as it was.
- **Afterwards:** `POST /v1/notes` reads stems that are already written (nothing in the app
  calls it yet). Reading takes seconds and writing none, so they are two steps
  (`read_stems`, `write_notes`): the second starts from the manifest as it is then and
  changes only what the notes need, so a tempo typed, a stem hidden or a file renamed
  meanwhile is kept. Either everything is written or every file is put back as it was.
- **A file that is not a stem's own is never written over or removed:** the reading is
  refused. Melodyne saves the MIDI it exports as `<audio name>.mid` beside the audio, which
  is the very name a stem's own MIDI takes. A stem's own files are the ones its manifest
  names, and ones that are exactly what the app writes there (`_adopt`): a notes file of
  the app's for that stem, and the MIDI file made from it, to the byte. A write cut short by
  an order of writing since given up left such files unnamed, and a rename or a new tempo
  cut short can. A file somebody saved is never, byte for byte, what the app makes of the
  notes file beside it.
- **A write that is cut short is finished by the next.** The manifest is written before the
  files it names, and a stem's notes file after its MIDI file: it is the notes file that
  says a stem is read, and on which tuning. A process that ends in between leaves a manifest
  naming a file that is not there, or a notes file that still says the old tuning, and the
  next reading writes what is missing. Written last, the manifest left files nothing named,
  in the way for ever.
- **Putting back is a rename.** What a file held is parked beside it until the whole write
  is done, so undoing a write needs no room on the disk and cannot leave half a file. A
  file that is open in another program cannot be parked, and then nothing is changed. The
  same holds for a notes file of another stem that is there and cannot be read: decided
  without it, the song's tuning could be another than that stem's MIDI file is on.
- **The MIDI file is made from the notes file,** to the byte, with the song's name, tempo
  and key from the manifest (`midi_from_sidecar`): in a run, afterwards, on a retag.
- **One writer at a time:** in the API process everything that rewrites a stem folder's
  manifest (notes, a tempo or key, hidden stems, a rename) holds one lock per folder
  (`Service._folder`), and a rename holds the folders' new names as well. While the job
  that is running may be writing a folder, all of them are refused there
  (`Service._not_being_written`): what they changed would be gone when the run replaces the
  folder. The check that was there before could never say yes. It asked the running job for
  its output folder, which a job has only once it is done.
- **A retag** writes each MIDI file again from its notes file, since a MIDI file counts in
  beats. **A rename** takes both files along and writes the song's new name inside the MIDI
  file, where a DAW reads the track's name, but only into a MIDI file that still is what
  the app made of its notes file: one somebody changed keeps its bytes. A notes file that
  is damaged or gone never stops either, and that stem's MIDI file stays as it is; one that
  is there and cannot be read now stops both, as a stem that is open does.
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
| Vocals (vocadito) | 0.392 | 0.778 | 0.784 | 40 |
| Guitar solos (GuitarSet) | 0.324 | 0.801 | 0.855 | 180 |
| Bass (Slakh's own stems) | 0.658 | 0.838 | 0.937 | 142 |

Those are every clip of each set, and the settings and weights were fitted on every other
one. On the half nothing was fitted on: 0.775, 0.854 and 0.927. The rest (the level a stem
is read at, low bass, how far the confidence can be trusted, what the wrong notes are,
chords, tuning, velocity) is in `docs/research/stem-to-midi.md`, section 14.

- **Not measured on separated stems.** Phase 7's acceptance asks for separated stems, and
  that run needs the GPU. The transcriber was run on the separated stems of the project's
  three test songs as a check that it behaves; there is no reference to score those against.
- **A stand-in was measured in their place:** each held-out clip with the rest of a song
  under it (a bass with its own song's other stems; a voice or a guitar solo, which come
  alone, with a Slakh song's whole mix). Onset F1 of what is shown:

  | Read | Vocals | Guitar solos | Bass |
  | --- | --- | --- | --- |
  | alone | 0.775 | 0.854 | 0.927 |
  | the rest 25 dB under it | 0.771 | 0.853 | 0.920 |
  | the rest 15 dB under it | 0.743 | 0.833 | 0.881 |

  It says the transcriber does not fall apart with other sound under the stem. It does not
  say what it scores on separated stems: a separator leaves what it could not tell apart,
  not an even share of everything, and adds faults of its own. By how sure SwiftF0 is of a
  pitch, the two real bass stems to hand lie between the clean reading and the 25 dB one.
- **Low notes rest on two things:** steady test tones down to 30.9 Hz (a 5-string's low B),
  which the double-speed pass follows, and Slakh's bass played 7 semitones lower, whose
  lowest note is 36.7 Hz. No real low bass was measured.
- **A voice's confidence ranks weakly** (AUC 0.70 on held-out clips, 0.87 for guitar
  lines): what counts as wrong there is mostly how a phrase is written down, a note a key or
  two from the reference's or one cut where the annotator held it. A second annotator
  scores 0.74 against the first.
- **Chords** are one line of what is played until stage M4.

## Known limits

- **Two processes can still write one manifest at once.** The lock on a stem folder is the
  API process's. The worker reads a cached song's notes (`Pipeline._with_notes`) in its own
  process, and it too starts from the manifest as it is when it writes, so what could be
  lost is a change the API makes within the same few milliseconds.
- **The level a stem is read at** is one figure for every kind of stem. On clean recordings
  0.25, 0.35 and 0.5 score within 0.003 of each other, and a bass with the rest of its song
  under it scored the same at all three. Real separated stems may still prefer another.
- **A change made in a `.mid` itself is lost at the next tempo or key.** The MIDI file is
  made from the notes file, so a retag makes it again. A rename leaves a changed file
  alone.
- **The lock on a folder goes by its path as it is spelled.** Two spellings of one folder
  (another case on a Mac, a link) would be two locks. The app has one spelling, the one the
  API gave it.
- **A pure sine is read poorly.** SwiftF0 was trained on sounds with harmonics. Of ten
  notes from E1 to E4 as steady pure sines the bass reading shows 9, and of the same notes
  dying away as an 808's do, 6; with a second harmonic 30 dB under the sine, all 10. A clean
  sub-bass or a clean 808 may lose notes. A second look, with a little distortion added and
  only where the first look heard no pitch, showed 9 of the 10 dying sines and left real
  recordings as they were, with bleed too (section 14). It is not in the engine: it reads a
  pure low B as the B above, doubles the tracker's work, and wants real 808s first.
- **The chords mark errs under heavy bleed.** With the rest of its song 15 dB under it, a
  bass is mostly called chords (section 14): SwiftF0 is less sure of any pitch.
- **A stem that is only bleed** but louder than the 45 dB that counts as empty (ADR 0027) is
  read at full level like any other, and can give a note or two of the part that bled in.
  On the project's three test songs one such stem (a piano, 41 dB under the loudest stem)
  gave one note. Whether a stem holds a part at all is the empty rule's question, not the
  transcriber's.

## Consequences

- `swift-f0` 0.3.0, `onnxruntime` 1.32.0 and `soxr` are dependencies of every build.
  onnxruntime's Apple Silicon wheel needs macOS 14, the app's own floor. On Windows it
  needs the Visual C++ runtime (`msvcp140.dll`), as PyTorch's own files do: neither brings
  it, so it asks nothing of a machine that a separation did not ask already.
- A stem of 6 minutes 26 seconds takes about 2 seconds on two CPU threads of the development
  PC. Nothing runs on the GPU, so there is no memory to plan for and no MPS path.
- A song separated before this version gets the new notes the next time it is queued with
  "Write MIDI" on, from the cache.
- The API process may transcribe: the module imports no torch (a test holds it to that).
- **A Mac:** the code is the same on both systems and nothing in it or its tests is
  Windows-only. No test of this change has run on a Mac: CI runs on pull requests and on
  `main`, and this branch has neither yet. onnxruntime's arm64 wheel going in through
  first-run setup has not been seen. ADR 0014 has the steps.
