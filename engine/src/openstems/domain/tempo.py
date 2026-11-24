"""When "Tempo-sync for FL Studio" cannot mark the stems, and what the job says about it.

FL Studio reads a sample's tempo from WAV files only: its manual says the tempo "meta-data"
is "only saved in .wav files". An MP3 or FLAC stem therefore never carries one, and a song
with no tempo has none to carry. Without a note on the job the setting would fail without a
word, which is how stems came to be dropped into FL unsynced (docs/adr/0016-tempo-sync.md).
"""

from __future__ import annotations

# Output formats (`audio.write.FORMATS`) whose files can hold the tempo.
TEMPO_FORMATS = frozenset({"wav32f", "wav24"})
_FORMAT_NAMES = {"mp3": "MP3", "flac": "FLAC"}

TEMPO_FORMAT_NOTE = (
    "No tempo for FL Studio in these {format} stems: it reads tempo only from WAV files. "
    "Choose WAV to embed it"
)
TEMPO_MISSING_NOTE = (
    "No tempo for FL Studio: none was found in this song. Type one in the Tempo field to embed it"
)


def carries_tempo(fmt: str) -> bool:
    """Whether files in this output format can hold the tempo FL Studio reads."""
    return fmt in TEMPO_FORMATS


def tempo_notes(tempo_sync: bool, fmt: str, bpm: float | None) -> list[str]:
    """Why stems written with tempo sync on carry no tempo, if they carry none: the format
    cannot hold it, or there was no tempo to write. Empty when they carry it, or when the
    setting is off."""
    if not tempo_sync:
        return []
    if not carries_tempo(fmt):
        return [TEMPO_FORMAT_NOTE.format(format=_FORMAT_NAMES.get(fmt, fmt.upper()))]
    if not bpm or bpm <= 0:
        return [TEMPO_MISSING_NOTE]
    return []


def notes_after_retag(notes: list[str], bpm: float | None) -> list[str]:
    """A job's notes once the user has set its tempo by hand: with a tempo now, the note
    that none was found goes. A tempo taken away on purpose brings no note back: the user
    said the song has none."""
    if bpm and bpm > 0:
        return [n for n in notes if n != TEMPO_MISSING_NOTE]
    return notes
