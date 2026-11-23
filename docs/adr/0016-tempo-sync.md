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

So FL Studio reads the tempo and ignores the beat count, and the count is left at 0.

## Limits

- WAV only. FLAC and MP3 cannot carry the chunk, and the setting does nothing for them.
- The stems are only as in time as the detected tempo is right. The detector rounds to a
  whole number within 0.25 BPM; an error of 0.1 BPM at 120 is about 0.15 s after three
  minutes, and a song played without a click has no single tempo. There is no way to
  correct the tempo in the app yet.
- The chunk says how fast the audio is, not where the first beat is.
- Only FL Studio 2026 on Windows was tried. Other programs that read `acid` chunks may also
  act on it. Not tried in FL Studio on a Mac; the bytes written are the same there.
- The option is part of a run's cache key only when it is on, so earlier results stay
  cached.
