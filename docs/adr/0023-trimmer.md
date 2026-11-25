# 0023: The trimmer: a part of a song on a beat grid

Date: 2026-11-23. Status: accepted. Not in `PLAN.md`.

## The problem

The owner, a producer who works in FL Studio, asked for it in these words:

> realistically, a lot of the time, the key and bpm detection is wrong, or the grid is off
> and i want to trim it anyways. i want to build an audio trimmer, but preferably one where i
> can also set the starting grid point and select freely but also select with a grid. Then
> with the trimmed section i could drag that and get the trimmed section. I should be able to
> do this with audio files PRE-SEPARATION as well as individual AND GROUPS of stems post
> separation.

A producer often wants a few bars of a song, not the whole of a stem: a drum loop, a vocal
phrase, the kit as one file. Until now the stems and mixes (ADR 0013) were whole songs, to be
cut again in the DAW. The tempo could be typed over (ADR 0019), but where bar 1 is could not
be set at all, and detection is often wrong about the tempo (half or double) and more often
about bar 1 (a pickup taken for it, a grid an eighth note late).

## Three prototypes

Three designs were built as prototypes outside the app, on two synthetic songs that go wrong
the way real ones do: one detected at double its tempo and slightly off (173.4 for 87), with
bar 1 on a two-beat pickup, separated into six stems with a drum kit; one with the right
tempo and a grid an eighth note late, waiting in the queue. Each was reviewed and fixed
once, then the three were compared. The prototypes were not committed; the chosen one was
ported into the app.

- **Ruler**: trimming in place, in the stems panel at its 460 px width. A ruler and a
  selection across the stem rows, with a grip on every row and group heading.
- **Editor**: a Trim button opens a focused editor across the main area, one song at a time.
  Chips choose what is trimmed, a toolbar and the ruler fix the grid, one tall waveform takes
  the selection, and handles in a footer drag it out.
- **Bars**: the grid first. The song is laid out like text in lines of 4 or 8 bars, a
  selection is made of bar cells, bar 1 is set by clicking the first downbeat, and the tempo
  by eye until the downbeats stand in one column.

**The owner chose the Editor.** Against the other two, the reviews found:

- Ruler: the timeline had 253 px of the panel, about 7 px a bar at 87 BPM, so most
  selections and the bar 1 drag needed a zoom first. An exact tempo meant typing it: Half
  gave 86.7, which drifts about 0.3 s by bar 33. A drag inside the selection started a new
  one.
- Bars: a selection stays on its bar numbers while the grid is fixed, so halving the tempo
  doubled its length. Bar 1 had no nudge finer than a sixteenth, and its snap to an attack
  could land 20 to 70 ms late on a soft one.
- Editor: one song gets the whole width. The two-point fit sets an exact tempo with the
  pointer (on the first song, Half gave 86.7 and dragging bar 25's line onto its beat gave
  87.00), and a selection moves by its body.

## Decision

- **One tempo per song.** Fixing the grid in the editor sets the song's tempo everywhere,
  through the same retag as the tempo field (ADR 0019): `POST /v1/jobs/{id}/analysis` for a
  song in the queue, waiting or separated, and `POST /v1/stemsets/analysis` for one from the
  History. The manifest, file names made with `{bpm}` and the tempo FL Studio reads follow.
  There is no tempo of the editor's own, so the editor, the tempo field and the files never
  disagree.
- **Bar 1 is saved with it**, as `downbeat`, seconds into the song (see "Bar 1" below). It
  renames nothing.
- **Separating only a part is a setting**, "Separate only the trimmed part" in Settings >
  Queue (`separate_selection`), off by default. Off, a selection on a waiting song gives
  clips of the song's own file, and the whole song is separated. On, the part chosen is all
  that Start separates ("Separating only the part" below).
- **Clips are written before the drag**, from handles made for it, as mixes are (ADR 0013): a
  native drag needs a real file before it starts. The selection itself is never dragged.

### The editor

`app/src/trimmer/`: `TrimEditor.tsx` (the top bar, the grid toolbar, the transport and the
footer), `Stage.tsx` (the ruler, the waveform, the overview), with the decisions as plain
functions in `model.ts` and `song.ts`.

**Ways in.** Trim on a song's row in the queue, while it waits to start or once it is
separated, and Trim in its right-click menu. Trim in the stems panel, from the Queue and from
the History: the editor opens on what solo and mute leave audible there (every stem when
nothing is soloed or muted: the panel plays the stems, not the song's own file; more than 8
stems open on the song's own file instead, see Limits), and Back
brings the panel back with solo and mute as they were. A History row has no Trim button of
its own. The quick-drop window has no editor. Where a row is narrow (the stems panel open in
a small window), its Trim keeps only its icon and the recipe gives way before the song's
name; narrower still, a waiting row leaves its Trim to its menu, for its tempo and key
fields.

**In place of the view.** The editor covers the view and the stems panel; the sidebar stays.
A click in the sidebar, Ctrl+1 to 4 (Cmd on a Mac) and the Mac menu's Settings leave it, and
a song taken off the list closes it. Songs dropped while it is open are queued without the
view switching under it, so Back returns where it came from. The view stays under the editor
as it was (the queue's scroll, the History's search), out of reach of the pointer, the keys
and screen readers, and not drawn once the editor has come in; Back finds it as it was left,
and nothing in it plays its entrance again. Only the stems panel goes, once the editor has
come in: until then it is paused and leaves Space to the editor. The song is read live from the
jobs (or from its stem set as last saved), so stems a retag renamed, or a waiting song that
got separated meanwhile, come in.

**What is trimmed: the chips.**

- **Original** is the song's own file, offered while it exists. It is drawn and played from
  the engine's preview of it (`POST /v1/sources/preview`, below). The first preview of a song
  takes a few seconds: the chip shows a spinner and the stage says "Reading the song". If it
  cannot be read, the chip carries a warning mark with the reason, and the stems still work.
- A waiting song has only Original, with "Single stems can be trimmed once it is separated."
- A separated song has a chip per stem, and a chip per group (Drums) that holds its parts. A
  click takes that chip alone. Ctrl+click (Cmd+click on a Mac) or Shift+click adds a chip or
  takes it out, for a mix named as the stems panel names one ("Drums + bass", "drums no
  kick"). Every stem at once is a mix of every stem, never the Original: the two differ
  wherever the stems do not add up to the song (drum-kit's parts overlap its drums, drumless
  has one stem, which its chip takes). The last stem cannot be taken out.
- Only what is chosen is heard, and it is decoded when it is chosen, not before: every-stem
  is 13 stems and the original. Its coarse peaks are drawn until then.
- Several chosen stems (a group, a mix, every stem) are drawn layered, each in its chip's
  color (`stemColor`), so what plays where shows before anything is heard: the drums under
  the vocals, the bass entering at bar 9. The Original and a single stem stay one waveform.

**The grid.**

- The toolbar holds the tempo field, a slot that says where the figure came from
  ("detected", then "was 173.4"; "none found", then "by hand"), Half, Double, Tap (or T;
  three taps give a tempo), Reset, and "Use 87" once a tempo has settled within 0.12 BPM of a
  whole one. Then "Bar 1 at" with −1 beat, −10 ms, the time (typed as 1.689 or 0:01.689;
  Enter on it as it reads puts bar 1 exactly there, since it shows milliseconds and bar 1 is
  kept to a tenth of one), +10 ms and +1 beat. Then Snap (Bar, Beat, 1/2, 1/4, Off) and Click, a click on every beat
  to hear whether the grid sits on the music.
- **The ruler.** Bar 1's flag moves the whole grid; with the focus on it, the arrow keys move
  it 10 ms and Shift+arrows a beat. "Show bar 1" brings it back when it is off screen.
- **The two-point fit.** Any later bar line dragged onto its beat sets the tempo so that the
  bar starts there, with bar 1 where it is (`fitBar`). The tempo follows the pointer during
  the drag and is kept to two decimals when the line is let go. A hint on the ruler says how:
  "Grid off? Drag the flag onto the first downbeat, then drag a later bar line onto its
  beat." while the grid is as detected, then "Bars drift later on? Drag a later bar line onto
  its beat to set the tempo exactly." until a bar line is fitted or a tempo typed or tapped.
- **When it is saved.** At once when the flag or a bar line is let go, and for a typed
  figure, Half, Double, "Use 87" and Reset; 400 ms after the last of a run of nudges; and
  once taps stop for 2 s. Leaving the editor before then (Back, Esc, a view switch) saves
  the nudge or the tapped tempo at once, as the way out starts. The tempo is sent only when it
  changed, since a new tempo renames files. The new grid shows at once, and stays shown after
  the save until the song has it: the jobs list tells the editor a tick later (React Query
  notifies on a timeout), and showing the old grid in between let a quick second gesture
  build on it (two Doubles saved twice the old tempo; on the Mac CI runner a typed bar 1 was
  joined to the old tempo). If the song never quite shows it, what was saved shows after a
  second. Saves go one after another: one is sent at once when none is on its way, else after
  it. Two at once could reach the engine in either order (its route runs on a pool of
  threads), and on CI a tempo saved with bar 1 pinned where it showed landed after bar 1
  typed just after it, so the song kept the old bar 1. A failed save puts the saved grid back
  and says why (a stem open in a DAW stops the renaming).
- **Where the figures come from** (`song.ts`, `songGrid`). A separated song has its tempo and
  bar 1 in its analysis. A waiting song has what its job was given, else what the preview
  detects. "was" and Reset refer to what detection found: `analysis.detected` once something
  was changed, the preview's figures for a waiting song. Reset on a waiting song takes the
  user's figures away, so the run detects again; on a separated song it saves what was
  detected.
- **A borrowed bar 1.** Where the song has no bar 1 of its own (a waiting song given nothing,
  a stem set from before this version), the editor shows the preview's, when the preview
  found the same tempo. A bar 1 fits only the tempo it was found with, so a borrowed one is
  saved with any change of tempo; otherwise the new tempo would leave the song with none.
- **No tempo found.** The grid is a stand-in of 120 BPM with bar 1 at the start. The tempo
  field is empty with 120 as its hint, and parts and clips are named by their times until a
  tempo is typed or tapped.

**Choosing a part.**

- Drag across the waveform. With Snap on, both ends go to the nearest line, and a short drag
  inside a bar takes that bar. With Alt held (Option on a Mac), or Snap off, the ends go
  where the pointer is. A line under the pointer shows where a press would land.
- Drag an edge to resize the part, and its middle to move it, in whole snap steps with its
  length kept. Shift+click moves the nearer edge to the pointer (with no part, it spans from
  the playhead). A double click takes one bar. A click without a drag moves the playhead.
- The edges are sliders: with the focus on one, the arrows move it to the next grid line, or
  10 ms with Snap off or Alt (Option) held.
- The footer says the part as its file is named: "Bars 9-16 · 8 bars · 22.07 s",
  "9.3 to 11.1 · 6 beats · 4.14 s" (at 87 BPM), or its times.
- A part stays on the audio when the grid changes afterwards; its name then follows the new
  grid, and may turn into beats or times. Fix the grid first, then choose.

**Seeing and hearing it.**

- Ctrl and the wheel zoom around the pointer (on a Mac, Cmd and the wheel, or a trackpad
  pinch); a plain wheel moves the view. The overview strip shows the whole song: drag its box
  to move the view, its sides to zoom. F fits the part, Z shows the whole song. Playing past
  the right edge turns the page, as a DAW does.
- Space plays and pauses, L loops the part, Play selection plays it once. Esc clears the
  part, then goes back. No key acts while a field has the focus, and a held key acts once.
- A part chosen where there was none (a drag, a double click, a length) is looped once the
  pointer lets go: a part is chosen to be heard round and round, and the first thing done
  with it was always L. After that the loop is the user's: on, it follows the part; turned
  off, it stays off for the parts after it, until the part is cleared (`selectionDone`, which
  compares with the part as it was before the gesture).
- Home, and the button left of Play, take the playhead and the view to 0:00 (`toStart`). A
  click puts the playhead on the nearest line, or at the song's start or end when that is
  nearer or the line is outside the song (`seekPlace`): a grid whose bar 1 is not at 0:00 has
  no line there, and the start could not be clicked.
- Length, in the toolbar beside Snap: 4, 8, 16, 32 and 64 bars (`BAR_LENGTHS`), and a field
  for any other number from 1 to 999, kept in local storage (`openstems.trim.bars.v1`) for
  the next song and the next start. With a part chosen it keeps its start and takes that
  length; without one it starts on the bar line at or before the playhead, or the first one
  in the song. A part that would run past the end moves back by whole bars; in a shorter
  song it runs to the end (`barsRange`). The length the part has is shown pressed
  (`barsOf`), and a part that reaches out of sight is shown whole. The lengths themselves
  are not a setting: one field covers the odd length without a list to manage.
- The waveform is drawn at any zoom from the decoded audio (`audio/pyramid.ts`), and from
  the engine's peaks until then, on whole device pixels. Layers (`drawLayers`) are ordered
  in every pixel column, quietest in front: each fills from its own peak to the next one in,
  so none hides another and no two paint the same pixel, and a stem loud for a moment shows
  there. Their colors meet without a seam, and outside the part they fade with the rest.
  Every layer has one scale, the loudest typical level of them all, so a quiet stem looks
  quiet. Playback (`audio/trimplayer.ts`) starts every track at one
  time, as the stems panel does; a stem whose leading silence was trimmed is padded back by
  its `start`, so a loop and the playhead mean the same on every track.

**The handles.** They sit in the footer, beside the part's readout, Loop and Play selection.

- **The clip handle** gives what the chips chose, cut to the part (`POST /v1/clips`): a clip
  of the song's own file, of one stem, or of a group or a mix as one file. Without a part it
  gives the whole: the song's own file, a stem's file, or a group or mix written as the stems
  panel writes a mix. It asks for its file 350 ms after the part settles, never while the
  part or the grid is being dragged or a grid change is unsaved, so no file is written
  mid-gesture. It shows the file's name once written, and a long name gives way in the
  song's name: what the file holds and its part ("drums - bars 3-6.wav") never do, found by
  the engine's `label` for it.
- **Every stem, this part** gives every stem cut to the part, one file each, or every stem
  whole without a part. It asks for its files only when the pointer or the focus reaches it,
  and for the part it was reached on: other parts tried afterwards write nothing until it is
  reached again.
- What the engine gave is remembered while the editor is open (`state/clip.ts`), so coming
  back to a part is instant. An editor opened anew asks the engine again (`forgetWritten`): it
  finds a clip that is still right, writes again one that was deleted, and replaces one cut
  from stems separated again since. A failed clip says why and tries again when pressed; a
  stem gone from its folder is named ("… is no longer in its folder: separate the song
  again"), since pressing again cannot bring it back.
- The song's own file, dragged whole, goes the way its title drags it (`lib/sourcedrag.ts`):
  let go over the app, it is not queued again. A clip let go over the app is queued like any
  file.
- "Clips go to …" under the footer names the folder: `<stem folder>/Clips` for stems,
  `<output>/<track>/Clips` for the song's own file. A long one is cut in its middle, so its
  last two folders always show. While "Separate only the trimmed part" is on, the same line
  says what Start will do.
- The footer's pieces have a width of their own at each width of the window (the footer is a
  container), so a part settling, a handle turning from Preparing to its file, or a note
  coming moves nothing beside them. While the editor is open, toasts rise above its footer
  (`--toast-lift`), where they would otherwise cover the handles.

**Leaving and coming back.** Back (Esc when no part is chosen) returns to where the editor was
opened. From the keyboard the focus goes back to the Trim control. What each song was left as
(the chips, the part, the snap, the view) is kept for the session, for up to 50 songs, and
never saved to disk (`trimmer/memory.ts`), with the timeline it was on (`origin`): a part
chosen on a waiting song that was then separated alone comes back on the part's stems, moved
by the part's start (`moveRange`), and so does one in an editor left open while the song ran.
What falls outside the part is dropped.

**Motion and layout.** Opening the editor is a rare moment: it rises 8 px and fades in over
220 ms with the ease-out, and leaves in 150 ms. Opened or left from the keyboard, it changes
at once. Reduced motion keeps the fade only. Chips, snap and the toggles change at once, as
solo does; only their press scales. The playheads and the clock are set on the elements every
frame, not through React, and a canvas redraws at most once a frame in the theme's tokens.
The toolbar's lines are chosen from the widths its three groups measure on screen (one line;
or tempo and bar 1, then the rest; or a group a line), measured again on resize and once the
font has loaded, so a wider font (SF Pro) breaks them sooner instead of overflowing. What
comes and goes in it keeps its place, so the ruler never moves under a drag: Reset and "Use
87" sit last, in slots of their own width, and "was" is as wide as the widest thing it can
say. Below 1000 px of footer, Loop and Play selection keep only their icons and the handles
their first line ("Every stem"). Screen readers hear the part once a drag ends, not at every
step of it. The bar 1 flag draws a ring when it has the keyboard's focus, as every other
control in the editor does.

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
  `engine/tests/fixtures/clip_labels.json`, which the tests of both read. The selection goes
  into the name after the template is tidied, so "bars -3--2" keeps its dashes, and a name
  that is too long is cut in the track's name, never in the selection.
- **The grid as drawn.** A clip's request carries the grid the app drew, taken as it is, not
  rounded, so that both name the selection alike. A song with no tempo sends none, and its
  clips are named by their times.
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
     first sample above -50 dB) is "1", since most songs start on bar 1. The low envelope is
     zero for its first frames (librosa pads its head), where a kick at the very start of the
     file had nothing to rise from and beat 1 lost a bar line: the start of a song is taken
     with a quarter second of silence before it (`_LEAD_SECONDS`), and an excerpt from the
     middle of a long song leaves its first 90 ms out for every beat alike.
  5. The grid steps back by whole bars to the first bar line at or after where the music
     starts, less half a beat: a pickup before bar 1 is bar 0. Bar 1 is then put 5 ms early
     (`ATTACK_LEAD`), so a clip starts just before the attack.
- **Set by hand** like the tempo and key (ADR 0019): a job's `downbeat` option, `downbeat` in
  `POST /v1/jobs/{id}/analysis` and `POST /v1/stemsets/analysis`, `analysis.downbeat` in the
  manifest with the detected one under `analysis.detected`. It is not in the cache key, and
  a cached result takes it. A change of bar 1 alone rewrites the manifest and nothing else:
  no file name or tempo mark holds it. What may be typed is decided in
  `grid.clean_downbeat`: -60 to 86400 seconds, kept to four decimals with a half rounded up.
  Its twin in the app, `cleanDownbeat` in `app/src/lib/grid.ts`, rounds the same way, with
  `Math.round(x * 10000) / 10000`: change both together.
- **Before the song's start.** The view never shows time before 0:00, so a flag dragged
  there was lost: off the left of the ruler, with a "Bar 1" button that could not scroll to
  it. Bar 1 may still be put there (a pickup). Its flag then waits at the left edge
  (`pinned` in `Stage.tsx`, "‹1" with no pole), and a drag from there brings bar 1 in under
  the pointer; a press without a drag leaves it. While the flag is dragged the song's start
  takes hold of it within the grab distance (`flagPlace`; Alt, Option on a Mac, places it
  freely), since 0:00 is where bar 1 most often belongs. 0:00 beside the field, dimmed while
  bar 1 is there, and a double click on the flag put bar 1 at the start. The double click is
  told by what its second press took hold of: with the pointer captured, Chromium sends the
  event from the ruler, not from the flag.

### A song's own file before separation

`POST /v1/sources/preview` (`pipeline/preview.py`) makes a song in the queue or the history
playable and drawable before it is separated: a 16-bit FLAC at 44.1 kHz, its peaks and the
detected grid, in `<cache>/previews/`, named by a hash of the song's path, size and time of
change. The 8 newest are kept; the editor asks again when the one it had is gone.
`is_served` serves that folder and no other new one. Any other path is refused: the app may
read a song's own file only when it is in the queue or the history.

Stems also say where they begin in the song: `start` (offset / 44100) on every stem the API
returns, filled in for jobs saved before it existed.

### Separating only the part

- **Setting the part.** `POST /v1/jobs/{id}/range` with `{"range": {"start", "end",
  "grid"}}` gives a waiting song the part to separate alone, and `{"range": null}` takes it
  away. Refused once the song has started ("this song has started: its part can no longer
  change", checked again under the queue's lock), and when a job is created with a `range`
  ("a part of a song is chosen once the song is in the queue"), so there is one checked way
  in. The times are checked as a clip's are and kept inside the song
  (`grid.clean_selection`).
- **Its name is decided when it is set**: by the grid it was chosen on, else by the tempo and
  bar 1 the job was given, else by its times (`clip_label`). The job keeps
  `options.range = {start, end, label}`. A job with no tempo of its own keeps the grid's
  tempo and bar 1 (bar 1 alone when it has that tempo, `_keep_grid`), so its run lays the
  bars out where the name says, and its row shows the tempo the editor did. The part is named
  again in the same step whenever the job's tempo or bar 1 changes, the row's tempo field
  included (`JobManager.set_analysis`): by both when the job has both, else by its times.
- **The run.** With `separate_selection` on when the song starts (the worker reads the
  settings for every job), only the part is separated, as a song of its own named
  "<song> (<label>)" (`Track.part`): its folder, `{track}` in stem names, the manifest's
  `source.name`, MIDI names and the history's track name. A long song name is cut, never the
  label, so two parts never share a folder by accident. The part is cut from the frames a
  clip of the same selection is cut from (`SongPart.frames`), so the two line up. Its
  timeline starts at the part's start: its stems' `start`, `analysis.downbeat` and the
  manifest's samples and duration are the part's, and `manifest.source.range` says where it
  came from. With the setting off, the range is ignored and the whole song is separated.
- **The cache key** carries the part's frames only for a part, so every other run keeps its
  key, and the same part separated again comes from the cache.
- **Bar 1 of a part** (`grid.part_downbeat`). A given tempo passes through, and bar 1 moves
  into the part. One inside the part or after it stays where it falls, at `downbeat - start`.
  One more than half a beat before the part moves on by whole bars to the part's first bar
  line: the grid lines stay where they were, and the bars are numbered from the part, as
  detection on the part would number them. Without a given tempo, a bar 1 before the part is
  dropped and detection finds the part's own. The literal `downbeat - start` falls below -60 s
  for any part more than about a minute after bar 1, which `clean_downbeat`, `make_grid` and
  the app's `cleanDownbeat` all refuse, so clips and bar 1 edits on that part's stems would
  fail. Only `part_downbeat` would change to go back to it.
- **What ran.** `JobInfo.part` and `StemSetInfo.part` (and a `part` column in the History
  index, added to an older index when it is opened and filled from manifests when it is
  rebuilt) say whether a part was separated, since the setting may have changed after the part
  was set. `options.range` is what was asked for.
- **In the app.** The switch is "Separate only the trimmed part" in Settings > Queue, with a
  hint that says what each position does. While it is on, the selection on a waiting song is
  its part: the editor sends it (`useSetJobRange`), with the grid that names it, once it has
  settled for 350 ms as a clip's request does; again when a new grid names it differently;
  and `null` when the selection is cleared. Leaving
  the editor within those 350 ms sends it at once. While the setting is off, the editor sends
  nothing. A part that could not be set says why, such as a song that has started.
- **What says so.** Once the job carries the part, the editor's readout says "Start
  separates only bars 9-16.", and the song's row in both windows adds it: "Ready to start,
  bars 9-16 only" (`statusText`, `jobRange` in `song.ts`). Opened again with the setting on,
  the editor shows the part the song carries when nothing else was left chosen. With the
  setting off nothing mentions a part. A part set earlier stays with the job and is ignored;
  turned on again, the setting makes it count, and the row shows it.
- **In the editor**, a separated part's stems are trimmed on the part's timeline, without the
  Original chip: the song's own file is on the whole song's timeline and would not line up
  (`song.ts`, `isPart`).

## Tests

- Engine: `tests/test_clips.py` (clips, bar 1 and the previews) and
  `tests/test_separate_selection.py` (the setting, the route and the run), with the
  FakeEngine and synthetic beats.
- App: `src/test/trimmer.test.tsx` covers the twins against the shared fixture, the plain
  functions of `model.ts` and `song.ts`, `useClipFiles`, the editor with the engine mocked
  and `src/test/trimstub.ts` standing in for Web Audio, the ways in, and the part a waiting
  song is given while the setting is on, the timeline a kept part is on, a nudge or a tap
  saved on the way out, Every stem written only for a part it was reached on, drags on a
  waveform given a width (nothing written mid-drag or on an unsaved grid, Alt placing
  freely), the stem padding and peaks placement (`padToSong`, `peaksOf`), and a song of
  more than 8 stems opening on one file. `src/test/layers.test.ts` covers the layered
  waveform: each layer from its own peak to the next, the order per column, silence as a
  line, and whole device pixels at twice the density.
  `src/test/mac.test.tsx` covers the Mac words, the zoom wheel, the chip key, and ⌘ with a
  letter left to the system; `src/test/tray.test.tsx` the quick-drop row's "only".
- End-to-end, `e2e/trimmer.spec.ts` on the FakeEngine: a finished song's grid fixed by hand,
  then a part of a stem, of every stem and of a mix dragged out as WAV files the length of the
  part; a waiting song's own file read and clipped, its tempo the one in its row; "Separate
  only the trimmed part" on, so that Start separates the part alone, into "First Song (bar 1)";
  Trim from the stems panel on what solo and mute leave audible, with both back after; and a
  stem that enters late (`OPENSTEMS_FAKE_LATE=vocals:1`, which leaves that FakeEngine stem
  silent for its first second, with Trim silence on) cut on the song's timeline, silent
  until it starts.
  The design-review screenshots take the editor in both themes (`trim-1-open.png` to
  `trim-5-queue-part.png`, and `light-trim-*`).
- Before that spec, the editor was driven with throwaway specs: a bar 1 nudge on a waiting
  song kept through its separation; a typed tempo, the flag moved from the keyboard, a
  bar-line fit (100 to 97.3 BPM); a song from the History; widths of 980 to 1480 px. On a
  205 s song the first preview took 3.3 s; then a stem took 0.8 s to load and a three-stem
  mix 0.85 s.
- Not done by hand on Windows either: dropping a clip into FL Studio or Explorer (in tests
  the main process records the paths instead of starting the drag, ADR 0005), and hearing the
  loop and the click (the tests run silent).

## Mac

Nothing of the trimmer has been seen by hand on a Mac. That includes bar 1's flag at the left
edge, the lengths, the loop that comes with a new part and Home (steps 11 and 12 below);
Home on a Mac's laptop keyboard is Fn with the left arrow, which Chromium reports as Home,
and the tooltip says so (`homeKey`). In CI on macos-15 (Apple Silicon, the
FakeEngine) its component tests and the whole end-to-end suite pass, first on PR #31. A test
that was flaky there showed a race Windows had hidden (a saved grid's draft dropped a tick
before the song had it), since fixed. What differs is decided in plain functions, tested on Windows with the
platform stubbed: the words (`freeKey` says Option, `modName` and `modClick` say ⌘), the wheel
(`isZoomWheel`, `zoomFactor`: Cmd and the wheel, or a pinch, which Chromium reports as a
wheel with Control held), and the key that adds a chip (`modKey`: Command, since a
Control-click is a right click). The pinch's speed is a guess. Paths keep the separator they
arrive with (`clipsFolder`). In the engine nothing branches by platform, except what the
system does with a file another program holds: on a Mac it can be replaced (that program
keeps the old one), so "(2)" for a held file happens on Windows only; a file newer than what
it was cut from is left alone on both. Paths of songs compare with case on a Mac
(`os.path.normcase`), without it on Windows.

For the owner, on the M1 Max:

1. Separate a song with `full-song` and open it with Trim on its row. The top bar should
   say "⌘-click to mix several stems". ⌘-click a second stem: both chips are chosen. A
   Control-click must not add a chip.
2. Hold Option and drag across the waveform: the part should be read in times
   ("0:08.815 to 0:18.345"), not in bars. Let go of Option and drag again: it snaps to bars.
3. ⌘ and the scroll wheel, and a pinch on the trackpad, should both zoom around the pointer,
   and a two-finger scroll should move the view. Say whether the pinch is too fast or too
   slow.
4. At the window's default size, the toolbar under the chips should break into lines with no
   divider at the start or the end of a line, and nothing cut off. Its lines are chosen from
   widths measured in the Mac's font, so they may break sooner than on Windows.
5. Choose a few bars of the drums and drag the clip handle into a DAW and into Finder; then
   the same with Original. The clips should be in `~/Music/OpenStems/<song>/full-song/Clips`
   and `~/Music/OpenStems/<song>/Clips`, and play the bars chosen.
6. Space, L with a part chosen, and Click: the sound should come out of the Mac, the loop
   should stay on the part, and the click should sit on the beat.
7. Press Esc twice: the first clears the part, the second goes back, and the focus is on the
   Trim button again.
8. Drop a song and leave it waiting. Trim: Original should show a spinner for a few seconds,
   then the waveform. Move bar 1 with +1 beat, then start the song: once separated, Trim
   should show bar 1 where it was left.
9. Turn on Settings > Queue > "Separate only the trimmed part". Drop a song, Trim, and choose
   a few bars: the footer should say "Start separates only bars …", and after Back the row
   should end in "… only". Start: the stems should be in
   `~/Music/OpenStems/<song> (bars …)/full-song/`, each as long as the part. Turn the setting
   off again afterwards.
10. On the separated song, click vocals, then ⌘-click drums and bass: the three should be
    drawn on top of one another, each in its chip's color, with no thin line between two
    colors on the Retina screen, and stay sharp when zoomed in. With a part chosen, they
    should fade outside it. Then in light (the switch at the foot of the sidebar).
11. Drag bar 1's flag (the 1 in the ruler) off the left edge: it should stay at the edge as
    "‹1", and the bar 1 field should show a time with a minus. Drag it from there back onto a
    beat. Drag it close to the left edge: it should jump to 0:00; with Option held it should
    not. Double-click the flag, and press 0:00 beside the field: bar 1 at 0:00 both times.
12. With no part chosen, press 8 under Length: 8 bars from the playhead's bar, with Loop on.
    Type 12 in the field beside it and press Return: 12 bars. Press L, clear the part with Esc
    and drag a new one: Loop should be on again. Fn+← (Home) and the button left of Play
    should take the playhead and the view to 0:00. Check that the toolbar still breaks into
    lines cleanly with the Length group in it.

## Limits

- **Detection was measured on synthetic beats only.** Clicks with a low thump on bar 1, at
  every whole tempo from 70 to 180 BPM, over 20, 30 and 60 s: within 1.4 ms (seven to nine
  tempos at the top of the range are detected at half, and 70 BPM once at double, as
  before). Songs of 200 to 420 s at tempos near a whole number but not on it (120.2, 127.8,
  125.15, 120.05, 128.07, 99.95, 140.12, 87.03, 174.2): within 2 ms. Drum loops (four on
  the floor, kick on 1 and 3, kick on 1 alone) and the clicks with a thump, 30 s each, at 15
  tempos from 70 to 170 BPM, with the first beat at 0, 10 ms, 30 ms and 0.5 s: bar 1 within
  30 ms in all 196 cases where the tempo was found. The other 44 were found at double or half
  (the loops at 70 and 80 BPM, kick on 1 alone at 87, every pattern at 170), a limit of the
  tempo, not of bar 1. Before the envelope's head was fixed, 65 of those loops, the ones that
  start with a kick within 30 ms of the file's start (a loop exported from a DAW), were put one
  beat late (two for kick on 1 and 3). The half-beat candidates (tracked beats twice as fast
  as the tempo) were in none of these. The three CC-BY test songs were not checked against
  their real attacks; Sneaky Snitch's bar 1 moved two beats, to where the song starts. The
  envelope fix left all three where they were (they are heard from their middle).
- **A pickup into a four-on-the-floor song** puts bar 1 a beat early: no beat stands out,
  and the tie goes to where the music starts. The editor moves it by a beat with +1 beat.
- **A tempo detected a few tenths off** (90.3 for 90) leaves bar 1 50 to 60 ms off, and a
  short song at a tempo between whole numbers up to about 25 ms. Correcting the tempo does
  not move bar 1, in the field or with the two-point fit.
- **At the whole song's zoom** a pixel is many milliseconds, so placing the flag or fitting a
  bar line needs zooming in first. Dragging a bar line to the left of bar 1 puts the tempo
  back where the drag started, which serves as a cancel.
- **"Every stem, this part" is written when it is reached**, so a grab within about half a
  second of reaching it gets nothing; its spinner says so.
- **The overview strip has no keys.** F, Z and the wheel cover zooming.
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
- **Every part that settles is written.** The clip handle asks for its file once a part has
  rested for 350 ms, so trying a few parts leaves a WAV of each in the Clips folder (the same
  part is found again, never written twice). Writing it only when the handle is reached, as
  Every stem does, would make the first grab after choosing a part fail for half a second;
  it is kept as it is until the owner says otherwise. Nothing deletes clips that were never
  dragged (ground rule 7).
- **A clip deleted while the editor stays open on its part** is still handed over by that
  editor, and the drag then does nothing (the main process drops a path that is gone). Opened
  again, the editor asks the engine, which writes it anew. Making the drag report that it
  handed nothing over would change the native drag, which no test can drive.
- **Every chosen stem is decoded whole**, about 85 MB a stem for a 4-minute song. Trim from
  the stems panel with nothing soloed or muted opens on every stem, since that is what the
  panel plays: about half a gigabyte for full-song's 6. More than `OPEN_STEMS` (8) left
  audible there, with nothing muted or with a few, open on the song's own file instead, or on
  the first stem when that is gone (`defaultPick`), so every-stem's 13 (1.1 GB) and mega-53's
  53 (about 4.5 GB) are never decoded unasked. Stems chosen by hand in the editor are not
  capped: Ctrl+click through 40 of mega-53's and they are all decoded.
  A long file costs the same per minute: an hour's mix is over 1 GB for its own file alone.
- **Reopening the editor on a part of the song's own file** decodes the whole song again in
  the engine before it finds the clip it wrote (`render_source_clip` cuts first, then looks),
  so its handle says Preparing for a moment. A clip of stems reads only the part's frames.
- **Two parts with the same name share a folder**, say "bar 2" before and after a grid fix:
  the newer run replaces the older one, as separating a song again does.
- **A part wholly before bar 1** is named like "bars -3--2", which stem file names write as
  "bars -3 - 2" (`render_name` tidies a run of dashes). The folder and the manifest keep
  "--", and so do clips, since their selection goes in after the template is tidied.
