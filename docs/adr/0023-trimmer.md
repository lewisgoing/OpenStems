# 0023: Clips of a song on a beat grid

Date: 2026-11-23. Status: accepted for the engine; the app's side comes with its UI. Not in
`PLAN.md`.

## The problem

A producer often wants a few bars of a song, not the whole of a stem: a drum loop, a vocal
phrase, the kit as one file. Until now the stems and mixes (ADR 0013) were whole songs, to
be cut again in the DAW. The engine now cuts the stretch itself, on a beat grid the user can
correct, since detection is often wrong about the tempo and more often about where bar 1 is.

## Decision

### Clips

`POST /v1/clips` (`pipeline/clip.py`) writes a stretch of a song as a file of its own, before
the drag starts, like a mix.

- **Of what.** Stems of one stem set: summed into one file (`together`, the default; a whole
  group goes by its name, so the kit is "drums", as in `mix_label`), or one file per stem.
  Or the song's own file, at its own sample rate, before it is separated or without it. The
  request's `source` says which: a stem that was itself separated (drums separated again for
  the kit) is both a stem and a song in the history, and the two readings cut different
  windows when silence was trimmed. Left out, one path that is a song in the queue or the
  history, or that is outside every served folder, is the song's own file.
- **Where.** `<stem folder>/Clips/` for stems, `<output>/<track>/Clips/` for a song's own
  file, beside its stem folders. The track's name is the queue's or the history's spelling
  of the song, not the request's.
- **The timeline.** Start and end are seconds of the song, which the file and every stem
  share; they are kept inside the song. A stem whose leading silence was trimmed begins at
  its `offset`, so the clip is silent until then. Every clip of one request has
  `round((end - start) * rate)` frames, and only that window is read from a stem.
- **Always WAV.** 24-bit when the stems are, float otherwise: an MP3's padding would put
  silence into a loop, and FL Studio reads a tempo from WAV alone (ADR 0016). With tempo
  sync on for the song (for a song's own file: the setting), the clip is marked with the
  grid's tempo.
- **Names.** The naming template, with `<stem or mix> - <selection>` as `{stem}` (the
  selection alone for a song's own file): "Satellite Rain - drums - bars 9-16.wav". The
  selection is named by `domain/grid.py` (`clip_label`): "bars 9-16" or "bar 9" on bar lines,
  "9.3-11.2" on beats, "0m21.40s-0m33.10s" otherwise. The app names it with `rangeLabel` in
  `app/src/lib/grid.ts`, so the arithmetic is the same in the same order, with JavaScript's
  `Math.round` (a half goes up) in both. The cases both must agree on are in
  `engine/tests/fixtures/clip_labels.json`. The selection goes into the name after the
  template is tidied, so "bars -3--2" keeps its dashes, and a name that is too long is cut in
  the track's name, never in the selection.
- **Never written over while it may be in use.** A DAW may hold a clip open, or keep it in a
  project and read it again later. Each clip carries `OpenStems clip <16 hex digits>` in its
  WAV's `LIST`/`INFO` comment: a hash of the files it was cut from, its first frame, its
  length, rate, format and tempo mark. A file of the clip's name that is newer than every
  file it was cut from is the clip when its comment matches, and is returned as it is.
  When the comment differs (the same bars on a corrected grid are another stretch of the
  song) or is missing (a clip the user edited and saved), the file is someone else's and
  the clip takes "<name> (2).wav", "(3)" and so on up to 99, each checked the same way. Only
  a file older than what it was cut from (the song was separated again) is replaced, through
  a temporary name; when the replace fails because a program holds the old file (Windows),
  the next name is tried.

### Bar 1

The grid is a tempo, the time of beat 1 of bar 1 (`downbeat`, seconds from the start of the
file, negative when bar 1 starts before it) and 4 beats to a bar.

- **Detected** with the tempo and key (`audio/analysis.py`, `detect_grid`), which never
  raises. The tempo is found as before (the tracked beats and a line through them). Then:
  1. The line is moved onto the onsets: a finer onset envelope (1.5 ms steps, over up to 30 s
     of the excerpt) averaged over every beat peaks where the beats are, within 70 ms. The
     tracker's own line runs 20 to 50 ms late, which would cut the attack off a loop.
  2. Two periods are tried for that average: the fitted line's and the reported tempo's.
     Over a short song the tracked beats bend the fit by a few tenths of a BPM and the
     snapped tempo is the true one; over a long song near a whole tempo but not on it (a
     vinyl rip, a live drummer) the fit is. A wrong period smears the average, so the one
     that peaks higher is kept, and it is used for everything below. The reported tempo is
     unchanged.
  3. Which beat is "1": the one whose bar lines carry the most low onsets (below 200 Hz:
     the kick usually lands on 1). The onsets within three frames of each line are summed,
     not their peak taken, since where an attack falls in a frame changes how it is split
     between frames; and only bar lines where the music plays count, since one in the
     silence before or after it scores as a beat without a kick.
  4. With a kick on every beat (four on the floor) or on 1 and 3, beats score alike: of those
     within 5 percent of the best (`PHASE_TIE`), the one nearest where the music starts (the
     first sample above -50 dB) is "1", since most songs start on bar 1.
  5. The grid steps back by whole bars to the first bar line at or after where the music
     starts, less half a beat: a pickup before bar 1 is bar 0. Bar 1 is then put 5 ms early
     (`ATTACK_LEAD`), so a clip starts just before the attack.
- **Set by hand** like the tempo and key (ADR 0019): a job's `downbeat` option, `downbeat` in
  `POST /v1/jobs/{id}/analysis` and `POST /v1/stemsets/analysis`, `analysis.downbeat` in the
  manifest with the detected one under `analysis.detected`. It is not in the cache key, and
  a cached result takes it. A change of bar 1 alone rewrites the manifest and nothing else:
  no file name or tempo mark holds it. What may be typed is decided in
  `grid.clean_downbeat`: -60 to 86400 seconds, kept to four decimals with a half rounded up.
  The app's twin must round with `Math.round(x * 10000) / 10000`.
- A clip's request carries the grid the app drew, taken as it is, not rounded, so that both
  name the selection alike.

### A song's own file before separation

`POST /v1/sources/preview` (`pipeline/preview.py`) makes a song in the queue or the history
playable and drawable before it is separated: a 16-bit FLAC at 44.1 kHz, its peaks and the
detected grid, in `<cache>/previews/`, named by a hash of the song's path, size and time of
change. The 8 newest are kept. `is_served` serves that folder and no other new one. Any
other path is refused: the app may read a song's own file only when it is in the queue or
the history.

Stems also say where they begin in the song: `start` (offset / 44100) on every stem the API
returns, filled in for jobs saved before it existed.

## Limits

- **Detection was measured on synthetic beats only.** Clicks with a low thump on bar 1, at
  every whole tempo from 70 to 180 BPM, over 20, 30 and 60 s: within 1.4 ms (seven to nine
  tempos at the top of the range are detected at half, and 70 BPM once at double, as
  before). Songs of 200 to 420 s at tempos near a whole number but not on it (120.2, 127.8,
  125.15, 120.05, 128.07, 99.95, 140.12, 87.03, 174.2): within 2 ms. Drum loops (four on
  the floor, kick on 1 and 3, a rock beat, kick on 1 alone, a hip-hop beat) at 15 tempos and
  4 starts each: bar 1 on the right beat wherever the tempo was found. The half-beat
  candidates (tracked beats twice as fast as the tempo) were in none of these. The three
  CC-BY test songs were not checked against their real attacks; Sneaky Snitch's bar 1 moved
  two beats, to where the song starts.
- **A pickup into a four-on-the-floor song** puts bar 1 a beat early: no beat stands out,
  and the tie goes to where the music starts. The app's grid can be moved by a beat.
- **A tempo detected a few tenths off** (90.3 for 90) leaves bar 1 50 to 60 ms off, and a
  short song at a tempo between whole numbers up to about 25 ms. Correcting the tempo does
  not move bar 1.
- **Clips of consecutive stretches can meet a frame apart**, since each is
  `round((end - start) * rate)` long from `round(start * rate)`. Inaudible.
  `round(end * rate) - round(start * rate)` would make them meet exactly.
- **Stem sets indexed before this version have no offsets in the index**, so their stems say
  `start` 0 until the index is rebuilt (History index in Settings, or
  `POST /v1/stemsets/rebuild`). Clips are cut from the manifest, so they are right regardless.
- **The first preview in a session** imports librosa in the API process (not torch) and pays
  for numba's compiling, a few seconds. A long song needs 100 to 300 MB while it is decoded
  and analysed.
- **FL Studio and the `LIST` chunk have not been tried.** To check on the development
  machine: turn on "Tempo-sync for FL Studio", make a clip of a few bars with a grid, drop it
  into a project at another tempo, and see that it stretches, plays at the right pitch and
  length, and that the clip menu's "Fit to tempo" offers the embedded tempo.
- **Mac.** Nothing here branches by platform. On a Mac a file another program has open can
  be replaced (that program keeps the old one), so "(2)" for a held file happens on Windows
  only; a file newer than what it was cut from is left alone on both. Paths of songs compare
  with case on a Mac (`os.path.normcase`), without it on Windows. The engine tests, these
  included, run on the Mac CI job. Nothing was run on a Mac by hand; once the app has its
  side, the owner should make a clip of stems and of a song's own file on the M1 Max and
  drop both into a DAW.
