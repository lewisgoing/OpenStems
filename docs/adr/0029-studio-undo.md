# 0029: Undo and redo in the trimmer

Date: 2026-11-25. Status: accepted. Not in `PLAN.md`.

## The problem

The trimmer's grid is the song's: a tempo typed, halved or tapped, and a bar 1 dragged or
nudged, are saved at once, to the job or to the stems on the disk (ADR 0019, ADR 0023). A
slip was therefore permanent the moment it was made. Double pressed twice, bar 1's flag
caught by a stray drag, a part cleared with Escape: the only way back was to remember the
figures and type them in again, or Reset, which goes all the way to what detection found
and throws away the good work before the slip as well.

## Decision

The editor keeps what the grid and the part were before each change, and Undo and Redo walk
through it.

- **What is a step.** A change that is complete: a gesture let go, a field committed, Half,
  Double or Reset pressed, a run of nudges or taps come to rest (they are already saved as
  one), a part chosen, moved, resized, set to so many bars, or cleared. A step holds the
  song's saved figures (tempo and bar 1, none as none), the grid they draw, the part and
  whether the ruler had stopped explaining itself (`Moment` in `trimmer/history.ts`).
- **What is not.** The zoom and the view, the snap, what is chosen to be heard, the loop,
  the click and the playhead. They are ways of looking and listening, not decisions about
  the song, and undoing them would put steps in the way of the one the user is after.
- **One history, in order.** The grid and the part share it, so Undo takes back the last
  thing done whichever it was. A new change after an undo leaves nothing to redo.
- **An undo is a save.** The grid goes back through the editor's usual save (`save` in
  `TrimEditor.tsx`): shown at once, sent after any save still on its way, and put back with
  a toast if the engine refuses (a stem open in a DAW). File names, the manifest and the
  tempo FL Studio reads follow, as for any change of the grid. Only what differs is sent
  (`figuresChange`).
- **Ahead of the song.** The song's figures reach the editor a moment after a save. Steps
  are taken from what the song is meant to have (`intended`, `settledGrid`), which a save
  moves at once and which is the song's own again whenever nothing is on its way, so two
  quick changes are two right steps.
- **A run of key presses is one step.** An edge of the part walked along the bars with the
  arrow keys records each press; changes of the part less than 700 ms apart are one step
  (`RUN_MS`), taken back whole.
- **A change still waiting is saved first.** Undo right after a nudge or a tap, before its
  moment to be saved has come: it is saved (`flush`), and is then the step taken back.
- **Kept while the app runs.** The steps are in the editor's memory of the song
  (`TrimMemory.history`), so a song left and opened again can still be put right. They are
  dropped when the song comes back on another timeline (a waiting song whose part was
  separated alone), and with everything else of the session when the app quits. 100 steps
  at most.
- **Keys.** Ctrl+Z, and Ctrl+Shift+Z or Ctrl+Y to go forward; Cmd in place of Ctrl on a
  Mac, worded through `shortcut` and `redoShortcut` (`src/platform.ts`). In a field the
  keys are the field's own undo, of what was typed there. Not during a gesture.
- **Two buttons beside Back**, always there so the bar does not move when the first change
  is made. With nothing to take back they are dimmed and say so; otherwise their hint says
  what the next step is ("Undo the beat grid", "Redo the part"). Nothing animates: the
  grid and the part are what change, and a key may have asked.

## Limits

- **The chips are not undone.** What is chosen to be trimmed stays as it is.
- **Not the tempo and key fields outside the trimmer.** A tempo typed in a queue row or the
  stems panel is saved there, with no history; the trimmer's next step still goes back to
  the figures it had seen.
- **A step taken back while the song has moved on elsewhere** (its tempo typed in the stems
  panel between two visits to the trimmer) goes back to the figures the step holds, not to
  the ones typed in between.
- **MIDI files keep the tempo they were written with**, as in ADR 0019.

## Windows and a Mac

The same code and the same tests on both; only the words for the keys differ, and
`src/test/mac.test.tsx` covers them with the platform stubbed. Tried on Windows in the
component tests and in the end-to-end suite (`e2e/trimmer.spec.ts`), where each undo was
read back from the song's manifest. Not seen on a Mac. To try it there: open a separated
song in the trimmer, press Double twice and drag bar 1's flag away, then Cmd+Z three times
and check the tempo field and the flag; Shift+Cmd+Z brings a step back.
