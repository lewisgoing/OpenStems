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
- **Pure tones:** a clean sub-bass or a clean 808 is a sine with nothing above it, and
  SwiftF0, trained on sounds with harmonics, is unsure of one. But a lone sine's pitch is
  the peak of its spectrum, at any pitch. So in a bass that is mostly pure tone (half its
  loud frames or more hold one partial, with all else at least 13 dB under it), a frame
  SwiftF0 hears no pitch in takes that partial's frequency (`with_pure_tones`). Where
  SwiftF0 is sure, its pitch stands. Such a stem also reads as a line: an 808 read as
  chords. Never frame by frame in any stem: a kick drum's low tail is the same sound as an
  808, and one that had leaked into a bass with harmonics, as loud as the bass, came out as
  a note each time.
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
- **A file that is not a stem's own is never written over or removed,** by a reading, by a
  new run of the song, by a new tempo or by a rename. Melodyne saves the MIDI it exports as
  `<audio name>.mid` beside the audio, which is the very name a stem's own MIDI takes. A
  reading that was asked for is refused and says which file; a run (new, or from the cache)
  leaves out that stem's notes and MIDI, says so on the job, and reads the other stems
  (`notes.theirs`). A stem's own files are the ones its manifest names, and ones that are
  exactly what the app writes there (`_adopt`): a notes file of the app's for that stem, and
  the MIDI file made from it, to the byte. Whether a file is the one the manifest names is
  asked of the disk, not of the spelling: Windows and a Mac do not tell `TUNE - bass.mid`
  from `Tune - bass.mid`.
- **It is asked last.** A reading asks before its seconds of work and again just before it
  writes. A run asks once every stem is written, just before its folder goes in, and the
  swap itself never writes over or removes a notes or MIDI file that is not the old
  manifest's own (`_replace_dir`, `notes.own`): a file saved while the stems were being
  written is somebody's as well.
- **A MIDI file is the stem's own only while it holds what the app wrote.** The manifest
  keeps the sha256 of the bytes (`midi_hash`), set by whatever writes the file: a run, a
  reading, a new tempo, a rename. One with other bytes was saved over the app's or edited,
  and from then on it is somebody's (`notes.changed`): not replaced, not rounded again in a
  new tuning, not given a new tempo or name inside, not removed when the stem has no notes
  or the song is separated again. The manifest also keeps the hash of what the file held
  just before (`midi_was`), since it is written before the file: a write cut short must not
  make the app take its own older file for somebody's.
- **A MIDI file of the old tracker** (up to 0.4.6, which kept no hash) came with the run
  that wrote its folder. One more than two minutes later than that run counts as saved
  there since. The run's time is the one the manifest keeps (`created_at`), which nothing
  rewrites. The stem's own time will not do: with tempo sync on, a new tempo rewrites the
  mark inside each WAV, and from then on the stem is newer than anything saved beside it;
  and a stem may have been moved away. With no time to go by, the file is not the app's.
- **A MIDI file that is there and cannot be read is nobody's to touch.** Whose it is, is
  read from its bytes. A reading, a new tempo and a rename stop and say which file; a run
  leaves that stem's notes out. On Windows that is a file another program holds, on a Mac
  one the app may not read, on either one a sync client has not fetched.
- **A file marked read-only is left as it is,** the same on both systems, by a reading (of
  its stem: refused; of another stem: that stem's two files stay on the tuning they are
  on), by a new tempo and a rename (which go through without it) and by a new run (which
  writes the stem without notes, and says so).
- **A name in a manifest is a file name.** A stem's files are joined to its folder and then
  moved, written over and removed, so `read_manifest` gives nothing for a manifest that
  names one outside its folder (`../x`, a path), and such a folder holds no stems to the
  app.
- **A write that is cut short is finished by the next.** The manifest is written before the
  files it names, and a stem's notes file after its MIDI file: it is the notes file that
  says a stem is read, and on which tuning. A process that ends in between leaves a manifest
  naming a file that is not there, or a notes file that still says the old tuning, and the
  next write puts there what is missing. It first brings back a file that was moved aside
  and never replaced, and clears what else was left (`recover`). A song that comes from the
  cache with nothing to read does the same (`mend`): nothing else would write to it. A
  rename and a new tempo clear up before they move the names, since what was left is found
  by the names the manifest has. Written last, the manifest left files nothing named, in
  the way for ever.
- **Putting back is a rename.** What a file held is parked beside it until the whole write
  is done, the manifest too, so undoing a write needs no room on the disk and cannot leave
  half a file. A file that is open in another program cannot be parked (on Windows), and
  then nothing is changed. The same holds for a file of another stem that is there and
  cannot be read, its notes file or a MIDI file that would be rounded again: decided
  without it, the song's tuning could be another than that stem's MIDI file is on. What a
  write puts on the disk is flushed before it is renamed into place, the manifest above
  all: after a power cut a manifest that cannot be read is a song the app no longer knows.
  (The other writers of a manifest do not flush yet.)
- **Why a change was refused is said as the system means it** (`notes.refused`), by a
  reading, a new tempo and a rename alike: on Windows a file is open in another program,
  on a Mac the app is not allowed to read or write it, and only Windows is told to close
  something. A change that fails for another reason (a full disk) says that reason.
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
  file, where a DAW reads the track's name. Neither touches the bytes of a MIDI file that
  is somebody's. A notes file that is damaged or gone never stops either, and that stem's
  MIDI file stays as it is; one that is there and cannot be read now stops both, as a stem
  that is open does. Both write their manifest last, as they did before there were notes,
  so before they touch a MIDI file they write the manifest that is there once more, with
  the hash each file is about to have beside the one it has (`rewrite_midi`, `on_disk`): a
  process that ends in between does not leave the app taking its own file for somebody's.
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

- **On separated stems, a first measure only.** 5 excerpts of 45 seconds from the held-out
  bass songs went through the app's own `full-song` recipe (on the CPU, with the owner's
  leave; the GPU is on hold), and the notes the run wrote beside the bass stem were scored:
  0.945 on the separated stems against 0.970 on the clean ones (precision 0.980, recall 0.919); the old tracker scores 0.626 on the same separated stems. Phase 7's acceptance asks for every stem class and the whole set, which waits
  for the GPU. The transcriber was also run on the separated stems of the project's three
  test songs as a check that it behaves; there is no reference to score those against.
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
- **A `.mid` changed by hand is on its own from then on.** It keeps its bytes. A new tempo
  or key does not reach it, and nothing says so then. Its stem's notes cannot be found
  again until it is moved or renamed, which the app does say, on the job or in its answer.
  Its notes file still follows the song.
- **Whose a MIDI file of the old tracker is, is a guess from its time.** One saved over
  the app's within two minutes of the separation is taken for the app's and replaced. A
  folder copied by a tool that does not keep file times has every old MIDI file taken for
  somebody's: nothing is lost, and the app says which files to move.
- **A name that fills a file name to the brim.** While it writes, a reading keeps files
  beside the notes and MIDI files whose names are up to 8 bytes longer than the notes
  file's. A Mac's disk holds 255 bytes a name, so a song of some 77 Japanese characters
  gets its notes from a run and not from a reading afterwards, which says the name is too
  long and changes nothing. Windows counts otherwise and has room.
- **What could not be removed at the end of a write stays until the next.** A file moved
  aside that the system would not let go of is cleared by the next write, rename, tempo or
  cached run of the song.
- **The lock on a folder goes by its path as it is spelled.** Two spellings of one folder
  (another case on a Mac, a link) would be two locks. The app has one spelling, the one the
  API gave it.
- **A note struck again can still be lost in a separated stem.** In one of the five
  separated excerpts 12 of 43 notes ran into the note before them, each a second strike of
  the same pitch. The cause: a separator takes a bass stem's highs away (23 of 96 mel bands
  still sounded there, 41 in the clean stem), and the onset strength is a mean over all 96,
  so a soft strike stood out 0.2 to 1.5 where 2.0 was asked. Cutting the clean stem at
  2000 Hz loses the same 12 notes. On 2026-11-27 a bass's threshold went from 2.0 to 1.0:
  6 of the 12 are found, the five excerpts read 0.962 (0.945 before; over all their notes
  476 right of 485 shown, 470 of 478 before), clean basses 0.954 (0.947) and basses with the
  rest of the song 25 dB under them 0.951 (0.941), both on the development half. Its price:
  of 157 real held sub-bass notes 112 read as one note (119 before), and 87 evolving low
  sounds give 786 notes (700). Two other ways were measured. Dividing the strength by the
  bands that sound finds 9 of the 12 (0.969) at the same price, but loses that when faint
  residue fills the empty bands (0.952 with the rest of the song 40 dB under the stem) and
  gains less on whole basses (0.950). A threshold of 0.5 finds 9 as well and cuts real held
  sounds a third more often (933 notes). Measured after the change went in (2026-11-27):
  with the rest 15 dB under the bass 0.916 (0.904), on basses cut at 700 Hz 0.928 (0.924),
  and on the held-out half 0.932 (0.927) alone, 0.928 (0.920) at 25 dB and 0.890 (0.881) at
  15 dB. The figures elsewhere in this record are from before the change. Guitar and other
  lines keep 2.5: no separated one has shown the fault.
- **The pure tone's own pitch is worth little on real sounds.** On clean sines made for the
  tests it finds every note where SwiftF0 lost a third. Real sub-basses and 808s (two free
  sample packs, section 14) carry enough above their fundamental for SwiftF0, which reads
  them, low ones too: of 157 real sub-bass notes whose pitch is known, 118 read right
  without it and 119 with it, and of 74 riffs 7 read otherwise. Of the benchmark's 142 real
  basses three count as mostly pure tone, and a stem's score moves by 0.003 at most. So it
  is there for the sine a software oscillator gives, and proven only on made ones.
- **A sound whose pitch dives comes out as a staircase.** One 808 hit that falls 3 to 19
  semitones while it rings is read as three notes or more (88 of 105 real 808 one-shots
  dive like that; the 10 that hold their pitch read as one note). The pure tone's own
  pitch follows more of the dive, so it is a longer staircase. Joining the pieces was
  tried and not taken up: a dive has no one pitch to give the joined note.
- **A sub that wobbles is cut at each wobble.** A real sub whose level or filter is swept
  by an LFO reads at the right pitch but in several notes (18 of the 157). So does one that
  ducks 12 dB or more under a kick, though less than before.
- **A stem that holds nothing but a kick's low end** gives a note for each kick, a short
  kick too, which gave none (such a stem is bleed: the last limit here).
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
  PC, a bass 2.5. Nothing runs on the GPU, so there is no memory to plan for and no MPS
  path.
- A song separated before this version gets the new notes the next time it is queued with
  "Write MIDI" on, from the cache.
- The API process may transcribe: the module imports no torch (a test holds it to that).
- **A Mac:** the code is the same on both systems and nothing in it or its tests is
  Windows-only. Its tests ran on a Mac for the first time in CI on 2026-11-26 (pull request
  48, `macos-15` on Apple Silicon: 605 passed, and the 2 that are skipped there are older,
  Windows-only ones), so SwiftF0 through onnxruntime's arm64 wheel gives the notes the tests
  expect there. Nothing has been seen on a Mac by hand: not that wheel going in through
  first-run setup, and not a real stem. ADR 0014 has the steps.
