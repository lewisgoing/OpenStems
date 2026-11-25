# 0027: A song can be renamed

Date: 2026-11-25. Status: accepted. Not in `PLAN.md`.

## The problem

A song went by its file's name, everywhere and for good: `y2mate - Artist - Song (Official
Video) [abc123]`, or whatever title a link came with. That name is the stem folder and,
through the naming template's `{track}`, the start of every stem dragged into a DAW. The
only way to change it was to rename the file before dropping it, or the stems afterwards,
one by one, behind the app's back.

## Decision

The user's name replaces the file's, before a song is separated or after, and the name on
the screen is the name on the disk.

- **The name is the song's.** It is not a label on one row. Every row of the same file in
  the queue follows a rename, the stems of every recipe the song was separated with are
  renamed together, and the file queued again later (History's "Run another recipe", a
  second drop) goes by the name it was given, so its stems land beside the others
  (`Service._given_name`: a row of the queue that has the name, else the song's stems in
  the history).
- **Before.** A job carries an optional `name` option (`RunOptions.name`, `Track.title`).
  The run uses it wherever it used the file's: the folder `<output>/<name>/<recipe>`, the
  stems' names, the manifest (`source.name`). It is not in the cache key. The folder is
  where a result is looked for, so a song under another name is another folder.
- **After.** Stems that are written are renamed on the disk (`pipeline/rename.py`,
  `rename_song`): the song's folder, the stems and MIDI files of every stem folder in it
  where the template holds `{track}`, and the name in each manifest. The index and the
  finished rows of the queue follow (`Service._rename_folder`, `JobManager.moved`). The
  audio is never rewritten.
- **The song's own file is never renamed.** It is the user's, and the app does not change
  what it was given. A clip of the song's own file goes beside the stems, under the song's
  name.
- **Nothing is written over, and nothing is left half done.** A folder or a file that
  already has the new name stops the rename before anything changes ("there is already a
  song called ..."). The folder is moved first: on Windows it cannot move while another
  program holds one of its files open, and then nothing has changed yet. A later step that
  fails undoes the ones before it.
- **Not while the song runs.** A rename is refused while a row of the song is being
  separated, or while the job on the GPU may be writing to the same folder.
- **What may be typed.** Up to 120 characters, spaces trimmed and runs of them made one.
  Characters a file name cannot hold (`/ : ? * " < > |`) stay in the name, as "AC/DC" should,
  and are replaced where the name is a folder or a file (`safe_component`, as it always did
  for a Mac file name with a colon). Only dots is refused. Empty gives the song its file's
  name back, on the disk as well. The rule is `clean_name` in `domain/naming.py` and
  `cleanName` in `app/src/lib/songname.ts`, both tested against
  `engine/tests/fixtures/song_names.json`: change both together.
- **A part separated alone keeps its label.** Its stems are a song of their own,
  "<song> (<label>)". On its row the song's name is typed and the label is kept on the
  disk; in the history its whole name is shown and typed.
- **Routes.** `POST /v1/jobs/{id}/name` and `POST /v1/stemsets/name`, each `{"name": ...}`
  with null for the file's own name. The second resolves with the stem set where it is now.

## In the app

- **In place.** The title turns into a field where it stood, in its own type, with the name
  selected: its margin takes back its padding, so the words do not move and the row keeps
  its height (`components/SongName.tsx`, `.name-input`). Enter or leaving the field saves,
  Escape puts back what was there. An emptied field shows the file's name, which is what the
  song is then called. It appears at once, with no motion: typing follows it, and a key may
  have opened it.
- **Ways in.** "Rename" in a queue row's right-click menu, after Trim. A small pencil beside
  the stems panel's title, there on hover or focus, and F2 while the panel is open, as for a
  file. A double click on a title, where a click does not move it: a waiting row, and in
  the queue and History the row whose stems are open. A row whose stems are closed opens
  them on the first click, which can reflow the list under the pointer, so the second click
  would land elsewhere: there a double click does nothing and the title's hint does not
  offer it. That was first seen in the queue on Windows and then in History on both CI
  runners.
- **The menu leaves the keyboard in the field.** A closing menu hands the focus back to its
  row, which would close the field again. An item that takes the focus itself says so
  (`takesFocus`), and the menu then leaves it alone (`finalFocus`).
- **The new name shows at once** and is kept until the list has it; when the engine
  refuses, the old name comes back and a toast says why, in the engine's words.
- **It says what it does.** The field's hint says that the stem folder and its files are
  renamed too, where stems are written.
- **The quick-drop window has no rename.** Its rows show the names; like Trim, the editing
  is the full window's.

## Limits

- **A project that already uses the stems will not find them.** A DAW keeps the path of a
  dragged file. Renaming the song moves that path, as renaming a folder in Explorer or
  Finder does. On Windows a DAW that has a stem open stops the rename; a project that is
  closed is not known about.
- **Mixes and clips keep the file names they have.** They move with the folder. A mix or a
  clip made after the rename takes the new name, so the same mix can then be there twice,
  once under each name. A clip may be in use in a project, which is why it is never renamed
  under it (ADR 0023), and a mix follows the same rule as in ADR 0019.
- **A part of the song separated alone has a folder of its own** and is renamed only on its
  own row, not when the whole song is.
- **A second rename that fails after a first one succeeded stays as it is.** A file with
  both whole-song stems and parts in the queue has several folders; they are renamed one
  after another, and one that is refused leaves the ones before it renamed.
- **The trimmer's memory of a song in the history is by its folder**, so what was left
  there is forgotten when that folder is renamed.

## Windows and a Mac

Nothing here branches on the platform: the same code, the same wording, the same tests on
both CI jobs. `safe_component` keeps a name valid on both. A change of case only ("song" to
"Song") is a rename on both. What differs is the system's own behavior: on a Mac a file
that is open elsewhere does not stop its folder from being renamed, so the "open in another
program" refusal is Windows'. Tried on Windows with the FakeEngine, in the unit tests and
in the end-to-end suite (`e2e/rename.spec.ts`), where a song was renamed while its stems
played. Not seen on a Mac. To try it there: drop a song, right-click it and choose Rename
before starting it, start it, check `~/Music/OpenStems/<name>/` and the stems' names; then
rename it again from the stems panel (the pencil, or F2) and check that the folder and the
files follow and still play.
