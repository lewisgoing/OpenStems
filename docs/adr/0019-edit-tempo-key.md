# 0019: The tempo and key can be typed over

Date: 2026-11-23. Status: accepted. Not in `PLAN.md`.

## The problem

The detected tempo and key are sometimes wrong: half or double the tempo, the relative
major for a minor key, nothing useful for a song played without a click. Until now they
could only be read. That mattered little while they were labels; with tempo-synced stems
(ADR 0016) a wrong tempo makes FL Studio stretch every stem wrongly.

## Decision

The user's figures replace the detected ones, before a song is separated or after.

- **Before.** A job carries optional `bpm` and `key` options. A song that waits in the queue
  shows two small fields that say "auto"; what is typed there is kept for the run
  (`POST /v1/jobs/{id}/analysis`), and a job can also be created with them. The run then
  uses them wherever it would have used the detected ones: file names, the manifest, the
  tempo mark. Detection still runs when its setting asks for it, and what it found is kept
  in the manifest as `analysis.detected`.
- **After.** The stems panel shows the same two fields for finished stems, from the queue or
  the history. A change (`POST /v1/stemsets/analysis`, or the job's route once it is done)
  re-tags the folder (`pipeline/retag.py`, `set_analysis`): the manifest, the names of stems
  and MIDI files made with `{bpm}` or `{key}`, and, when tempo sync was on for that run, the
  tempo mark in every WAV stem and in the mixes already made from them. The audio is never
  rewritten: the mark is changed in place (`audio/write.py`, `set_tempo`).
- **No tempo.** An emptied field means the song has none. The mark is then set to a tempo of
  0, which FL Studio does not sync to (ADR 0016, file C).
- **Not part of the cache key.** A song that is already separated is not separated again
  because its tempo was corrected: a cached result is re-tagged.
- **What may be typed.** A tempo from 20 to 999, kept to two decimals. A key as detection
  writes it: a note, an optional sharp, an optional `m`. A flat is accepted and written as
  the sharp that sounds the same (Bb becomes A#), so there is one spelling. The rule lives
  in `retag.clean_bpm` and `clean_key` and again in `app/src/lib/tempokey.ts`: change both
  together.

## Limits

- **Names of mixes are not changed**, only their tempo mark. A mix named with the old tempo
  keeps that name; making the same mix again writes one with the new name.
- **MIDI files keep the tempo they were written with.** Their notes are in beats of the old
  tempo. Separate the song again for MIDI at the corrected tempo.
- **Separating again with "ignore the cache" detects again.** The user's figures are kept
  through a cached run, not through a forced one, unless the job is given them.
- **A name that is taken stops the change.** If a file with a new name is already in the
  folder, nothing is renamed and the app says so.
- **The panel shows the tempo to two decimals now**, where it showed a rounded whole number:
  the exact figure is what gets written, so it is what should be seen.
- On Windows and on a Mac alike; nothing here differs by platform. Tried on Windows with
  the FakeEngine and in the end-to-end suite, which also runs on the Mac CI job. Not tried
  by hand on a Mac.
