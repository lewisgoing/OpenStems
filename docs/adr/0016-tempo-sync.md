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
- The stems are only as in time as the tempo is right. The detector gives a whole number
  when it is within 0.25 BPM of one, and one decimal otherwise (`audio/analysis.py`); an
  error of 0.1 BPM at 120 is about 0.15 s after three minutes, and a song played without a
  click has no single tempo. A wrong tempo can be typed over since 0.3.2: see "Correcting
  the tempo" below.
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

Since 0.3.8 the welcome on a first start (ADR 0021) offers the switch beside the choice of
format, and marks MP3 and FLAC there "FL Studio reads no tempo from it" while it is on.

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

## Correcting the tempo (ADR 0019)

A tempo typed over the detected one, before the run or after it, is the one written. For
stems already written, `write.set_tempo` changes the `acid` chunk in place in every WAV stem
and in the mixes made from them; the audio is not rewritten. A typed tempo keeps two
decimals (`retag.clean_bpm`, 20 to 999 BPM), and the chunk holds it as a 32-bit float, so
FL reads 123.45 as written. An emptied tempo sets the chunk's tempo to 0, which FL does not
sync (the "tempo 0" row above). The detected figures stay in the manifest under
`analysis.detected`. MIDI files keep the tempo they were written with.

## Known and not known (2026-11-24)

Seen in FL Studio 2026 on Windows, by the owner:

- FL reads the tempo field of the `acid` chunk and ignores the beat count. A tempo of 0
  does not sync, with or without a beat count. On a full-length stem, flags 4 or 0 made no
  difference (neither stretched, for its length); the flags were not varied on short files.
- 32-bit float, 24-bit and 16-bit WAV all carry it.
- FL stretches a sample by itself up to about a minute (60 s yes, 90 s no, at 80 and at
  155 BPM); longer ones need the clip menu's "Fit to tempo" with "(embedded)".
- "Read sample tempo information" must be on in FL's General settings.

Not tried, or not known:

- FL Studio on a Mac. The bytes are the same; nobody has dropped a stem into it there.
- Other programs. Ableton Live, Logic, Reaper and others may read an `acid` chunk, ignore it
  or act on it differently; none was tried.
- Where the limit between 60 and 90 seconds lies exactly, and whether it is a setting.
- Whether a typed tempo with decimals stretches as exactly as a whole one; FL shows it, but
  timing over a full song was not measured.
- The first beat, for a whole stem. The chunk says how fast the audio is, not where bar 1
  starts, and FL has no field for it that we know of. Since 0.4.0 the app knows bar 1
  (`downbeat`, ADR 0023), but a full stem still starts at the song's first sample; one whose
  song starts off the beat lines up in FL only after moving it by hand.

## Clips from the trimmer (0.4.0, ADR 0023)

A clip dragged out of the trimmer is always a WAV, and with tempo sync on for its song (for a
song's own file: the setting) it carries the grid's tempo in the same chunk. A clip cut on
bar lines starts on a downbeat, and a few bars are well under a minute, so a clip gets past
both limits above: it starts on bar 1 and FL stretches it by itself. Nobody has dropped a
clip into FL to confirm it yet. Each clip also carries a `LIST`/`INFO` comment
("OpenStems clip ..."), the app's own mark for not writing over a clip in use; FL is not
known to read it.
