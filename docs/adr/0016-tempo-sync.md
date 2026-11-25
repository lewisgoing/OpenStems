# 0016: Tempo-synced WAVs for FL Studio

Date: 2026-11-23. Status: accepted.

Not in `PLAN.md`.

## Decision

With the setting "Tempo-sync for FL Studio" on (`tempo_sync`, off by default), every WAV the
engine writes, stems and mixes, carries the song's detected tempo in an `acid` chunk. FL
Studio then stretches the file to the project's tempo when it is dropped in.

The chunk is 24 bytes after the audio, written by `audio/write.py` (`tempo_chunk`): the
"stretch" flag (4), root note 60, 4/4, a beat count of 0 and the tempo as a 32-bit float.
The flag, root note and meter are copied from a file FL Studio 2026 saved as tempo-synced.

The tempo is the one the engine already detects for `{bpm}` (`audio/analysis.py`). Turning
the setting on detects it even when "Detect tempo and key" is off. A song with no detected
tempo gets no chunk.

## What was tried

Two files from the user, the same riser saved from FL Studio 2026 with and without tempo
sync, differ in metadata only in the `acid` chunk: flags 1 and tempo 0 against flags 4 and a
tempo. Six files written by a prototype were then dropped into FL Studio 2026 on Windows by
the user, in a project at 115 BPM (2026-11-23):

| File | Synced |
|---|---|
| tempo 150, 16 beats, float | yes |
| tempo 150, 0 beats | yes |
| tempo 0, 16 beats | no |
| tempo 150, 8 beats (they disagree) | yes, as 150 |
| tempo 150, 16 beats, 24-bit | yes |
| a whole song, tempo 105, 98.93 beats long | yes |

So FL Studio reads the tempo and ignores the beat count, and the count is left at 0. (The
"whole song" was 98.93 beats at 105 BPM: 56 seconds. That is why it synced; see "Long
samples" below.)

## Limits

- WAV only. FL Studio reads tempo from WAV files alone (its manual: the tempo "meta-data" is
  "only saved in .wav files"), so FLAC and MP3 stems carry none. See "Saying so" below.
- The stems are only as in time as the detected tempo is right. The detector rounds to a
  whole number within 0.25 BPM; an error of 0.1 BPM at 120 is about 0.15 s after three
  minutes, and a song played without a click has no single tempo. There is no way to
  correct the tempo in the app yet.
- The chunk says how fast the audio is, not where the first beat is.
- Only FL Studio 2026 on Windows was tried. Other programs that read `acid` chunks may also
  act on it. Not tried in FL Studio on a Mac; the bytes written are the same there.
- The option is part of a run's cache key only when it is on, so earlier results stay
  cached.

## Saying so (2026-11-23)

The owner found that FL Studio often showed no tempo for stems written with the setting on.
Of the 241 stems in the output folder, every WAV written with the setting on carried the
chunk (6 of 6, and their mix); the other 130 written with it on were MP3, the format the
owner had chosen, and carried none. The setting did nothing for them, without a word, and
the hint that said so sat under a different control from the format picker.

The owner chose to keep the chosen format and to warn, rather than to write WAV regardless
or a WAV beside each MP3:

- The format list, on the drop bar and in Settings, marks MP3 and FLAC "No tempo" while the
  setting is on, and Settings says under the switch when the chosen format cannot carry it.
- A song written with the setting on and no tempo in its stems carries a note, on the job
  and in its manifest (`domain/tempo.py`): the format cannot hold it, or no tempo was found.
  The second goes when the user types a tempo in (`retag.set_analysis`); a tempo taken away
  on purpose brings no note.
- The hint names FL Studio's "Read sample tempo information" option (General settings),
  which must be on for FL to read any tempo from a sample.

FL Studio does not read a tempo from a file name or from MP3 or FLAC tags, as far as its
manual says, so there is nothing to write into those formats.

## Long samples (2026-11-23)

A stem written as WAV with the chunk still did not stretch: FL showed its tempo ("155 BPM")
but loaded it with Mode "Resample" and the TIME knob at none. The owner dropped test files
cut from that stem into a project at 140 BPM, each changing one thing:

- Eight variants of the whole 198 s stem (32-bit float, 24-bit, 16-bit; flags 4 or 0; a
  beat count of 0 or 512, as Edison writes it) all loaded unstretched. 20 s cuts of it,
  float and 16-bit, stretched. So the file's contents do not decide it.
- Lengths at 155 BPM: 25, 30, 35, 45 and 60 s stretched; 90, 120 and 150 s did not. At
  80 BPM: 45 and 60 s stretched; 90 s (only 30 bars) did not. So the limit is in seconds,
  somewhere between 60 and 90, not in bars.
- "Keep on disk", which FL turns on for samples over 30 s when "Auto keep long audio on
  disk" is set, is not the cause: a 24-bit file cannot be kept on disk and still did not
  stretch.

FL's manual says nothing of this limit. For a longer sample FL still knows the tempo: the
clip menu's "Fit to tempo" offers it as "(embedded)", and picking it stretches the stem to the
project, which the owner found works "almost flawlessly". Picking "(project)" instead tells FL
the sample is already at the project's tempo, so nothing stretches. The tempo sync hint in
Settings gives this step. A full-length stem is almost always over 90 seconds, so this is the
ordinary way stems are used with the setting, not an edge case.

