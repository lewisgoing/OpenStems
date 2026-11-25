# 0027: Empty stems are hidden, not skipped

Date: 2026-11-25. Status: accepted. Not in `PLAN.md`.

## Context

A recipe writes every stem it names. A rap song through the six-stem recipe gets a guitar
and a piano with nothing in them, and the lists showed six rows and six pills of which one
or two held sound. In the quick-drop window the pills look alike, so the stem worth
dragging could not be told from the five that were not.

## Decision

The engine says which stems are empty, and the app leaves them out of its lists unless the
"Hide empty stems" setting (`hide_empty_stems`, on by default) is off.

- **Hidden, never skipped.** Every stem is still written. A missing file would break
  Sum to mix (the stems must add up to the song), templates that expect six files, and the
  cache, and a wrong verdict would lose audio. Hiding can be undone with one click.
- **The rule** (`domain/levels.py`): a stem is empty when its peak is more than 45 dB under
  the loudest stem of its set. A stem whose peak is not known is never empty. A set of
  silence is all empty, and the app then shows every stem.
- **Relative, not absolute.** A quiet recording keeps its quiet parts: a kick at -42 dBFS
  beside a loudest stem at -15 dBFS is 27 dB under it and stays.
- **Why 45 dB.** Read from the 43 stem sets on the development machine on 2026-11-25 (peaks
  from their peaks files, in dBFS; "active" is the share of the stem above -50 dBFS):

  | Stem (song's loudest stem) | Peak | Active | Under the loudest | Verdict |
  | --- | --- | --- | --- | --- |
  | guitar, piano (Money Longer, +0.4) | -74.0, -70.5 | 0% | 74, 71 | empty |
  | guitar, piano (you suck, +3.7) | -51.7, -49.6 | 0% | 55, 53 | empty |
  | piano (magic, +2.2) | -49.1 | 0.1% | 51 | empty |
  | kick (Echo, +1.8) | -45.8 | 2.5% | 48 | empty |
  | piano (Ocean Drift, -2.3) | -46.0 | 0.4% | 44 | shown |
  | crash (Cloudbusting, -4.6) | -43.5 | 0.1% | 39 | shown |
  | guitar (Cult Member, -0.4) | -38.9 | 0% | 39 | shown |
  | guitar (Being fine, +3.1) | -30.9 | 7.9% | 34 | shown |
  | kick (a quiet bounce, -15.5) | -42.5 | 10.4% | 27 | shown |

  What a model lets through into a stem with no part sits 50 dB or more under the song.
  Real but quiet parts were found down to about 35 dB under. 45 is between the two and on
  the careful side: a stem wrongly shown costs a row, a stem wrongly hidden costs a search.
  Peak alone is used, not loudness over time: one real crash in a song is a stem worth
  seeing, and it has a peak but almost no duration.
- **Measured before normalize** (`Pipeline.run`, kept as `peak` in the manifest). Normalize
  brings every stem to -1 dBFS, a hiss included, so afterwards nothing would be empty.
- **Older stems** have no `peak`. Theirs is read from the peaks file drawn for the waveform
  (`pipeline/levels.py`): the mono sum of the file as written, so a set made with normalize
  on shows every stem. Index rows and saved jobs are marked once when the engine starts.
- **What hiding covers in the app** (`lib/empty.ts`, `splitEmpty`): the stems panel, the
  pills of the quick-drop window, and the three handles that drag every stem (panel, queue
  row, quick-drop row), whose count is of what they carry. Dragging five silent files into
  a DAW is the same clutter as seeing them. What is hidden is not decoded or played either,
  and a mix is of the stems on show.
- **The way back is where the stems are**: a line under the panel's list ("4 empty: bass,
  guitar, piano, other", Show) and a "+4 empty" pill, each for one song and until the panel
  or the window is left. Shown, an empty stem is dimmed, and it is dimmed with the setting
  off as well, so the stems with sound are found either way.
- **The setting is with Sum to mix in Settings > Defaults**, not in the recipe bar. The
  bar's controls decide what a run writes; this decides what is shown, for every song
  already separated too.
- **Nothing animates.** Showing and hiding rows is a change to what is being looked at, and
  stems asked back by a click are there at once (the pills' entrance is for stems that just
  arrived).

## Not done

- The trimmer's chips list every stem. Trim from the panel opens on the stems shown.
- The tray icon's tooltip still counts every stem written ("is ready, 6 stems").

## Tests

`engine/tests/test_empty_stems.py`, `app/src/test/components.test.tsx` and `tray.test.tsx`
("empty stems"), `app/e2e/empty-stems.spec.ts`. `OPENSTEMS_FAKE_EMPTY=<stem>,<stem>` leaves
FakeEngine stems a hiss 60 dB under what they would hold.

## Mac

Nothing here differs by system. Not yet seen on a Mac.
