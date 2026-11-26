"""Optional post-processing: tempo and key, normalize, silence trim, stem to MIDI.

Everything here is off by default, and with the defaults the output contract is untouched:
stems keep the source's length, start and level.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from openstems.audio import analysis
from openstems.domain.stem import Track
from openstems.engines.base import CancelToken
from openstems.pipeline.levels import measure_peak

NORMALIZE_PEAK_DB = -1.0


def post_process(
    track: Track,
    mix: np.ndarray,
    outputs: dict[str, np.ndarray],
    options: Any,
    cancel: CancelToken,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    """Returns extras for the writer: ``bpm``, ``key``, ``downbeat`` (where bar 1 starts,
    in seconds), ``trim`` and ``midi``.

    ``outputs`` is modified in place when normalization is on.
    """
    extras: dict[str, Any] = {
        "bpm": None,
        "key": None,
        "downbeat": None,
        "trim": {},
        "midi": {},
        "offsets": {},
    }

    template = getattr(options, "naming_template", "") or ""
    wanted = getattr(options, "detect_tempo_key", False) or getattr(options, "tempo_sync", False)
    if wanted or "{bpm}" in template or "{key}" in template:
        bpm, key, downbeat = analysis.detect_grid(mix, sample_rate)
        extras["bpm"], extras["key"], extras["downbeat"] = bpm, key, downbeat
    # The user's own figures win, and what detection found is kept beside them.
    given = {name: getattr(options, name, None) for name in ("bpm", "key", "downbeat")}
    if any(value is not None for value in given.values()):
        extras["detected"] = {name: extras[name] for name in given}
        for name, value in given.items():
            if value is not None:
                extras[name] = value
    cancel.raise_if_cancelled()

    # Measured before normalize, as the run measures them: a stem of hiss is not read.
    peaks = {name: measure_peak(audio) for name, audio in outputs.items()}

    if getattr(options, "normalize", False):
        target = 10 ** (NORMALIZE_PEAK_DB / 20)
        for name, audio in outputs.items():
            peak = float(np.abs(audio).max()) if audio.size else 0.0
            if peak > 1e-6:
                outputs[name] = (audio * np.float32(target / peak)).astype(np.float32)

    if getattr(options, "trim_silence", False):
        for name, audio in outputs.items():
            start, end = analysis.silence_bounds(audio)
            if end > start and (start > 0 or end < audio.shape[1]):
                extras["trim"][name] = np.ascontiguousarray(audio[:, start:end])
                extras["offsets"][name] = start

    # Stem to MIDI comes last and reads each stem as it will be written, trimmed start
    # included, so a note's time is its place in the stem's own file.
    wanted = getattr(options, "midi_stems", None) or ()
    if wanted:
        _read_notes(track, outputs, peaks, wanted, extras, cancel, sample_rate)
    return extras


def _read_notes(
    track: Track,
    outputs: dict[str, np.ndarray],
    peaks: dict[str, float],
    wanted: Any,
    extras: dict[str, Any],
    cancel: CancelToken,
    sample_rate: int,
) -> None:
    """The notes of every stem asked for that has a line to read, as writers for its notes
    file and, when notes were found, its MIDI file."""
    from openstems.audio.transcribe import transcribe_line
    from openstems.pipeline import notes

    found = {}
    for name in notes.readable(outputs, wanted, peaks):
        trimmed = extras["trim"].get(name)
        audio = outputs[name] if trimmed is None else trimmed
        found[name] = transcribe_line(audio, sample_rate, name)
        cancel.raise_if_cancelled()
    tuning = notes.song_tuning(found)
    extras["said"] = notes.job_notes(found)
    extras["notes"] = {}
    for name, transcription in found.items():
        sidecar = notes.sidecar_of(transcription, stem=name, tuning=tuning)
        extras["notes"][name] = _writer(notes.write_json, sidecar)
        shown = transcription.shown()
        if shown:
            data = notes.midi_of(
                shown,
                stem=name,
                name=f"{track.name} {name}",
                bpm=extras["bpm"],
                key=extras["key"],
                tuning=tuning,
            )
            extras["midi"][name] = _writer(Path.write_bytes, data)


def _writer(write: Callable[[Path, Any], Any], data: Any) -> Callable[[Path], None]:
    def to(path: Path) -> None:
        write(path, data)

    return to
