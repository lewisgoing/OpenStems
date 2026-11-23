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
from openstems.audio.midi import write_midi
from openstems.domain.stem import Track
from openstems.engines.base import CancelToken

NORMALIZE_PEAK_DB = -1.0
# Pitch ranges per stem kind for stem-to-MIDI. Unknown stems use the wide default.
_RANGES: dict[str, tuple[float, float]] = {
    "bass": (30.0, 400.0),
    "vocals": (70.0, 1100.0),
    "dry vocals": (70.0, 1100.0),
    "lead": (70.0, 1100.0),
    "melody": (55.0, 1600.0),
}
MIDI_STEMS = tuple(_RANGES)


def post_process(
    track: Track,
    mix: np.ndarray,
    outputs: dict[str, np.ndarray],
    options: Any,
    cancel: CancelToken,
    sample_rate: int = 44100,
) -> dict[str, Any]:
    """Returns extras for the writer: ``bpm``, ``key``, ``trim`` and ``midi``.

    ``outputs`` is modified in place when normalization is on.
    """
    extras: dict[str, Any] = {"bpm": None, "key": None, "trim": {}, "midi": {}, "offsets": {}}

    template = getattr(options, "naming_template", "") or ""
    wanted = getattr(options, "detect_tempo_key", False) or getattr(options, "tempo_sync", False)
    if wanted or "{bpm}" in template or "{key}" in template:
        bpm, key = analysis.detect_tempo_key(mix, sample_rate)
        extras["bpm"], extras["key"] = bpm, key
    cancel.raise_if_cancelled()

    wanted_midi = set(getattr(options, "midi_stems", None) or ())
    for name in outputs:
        if name in wanted_midi:
            low, high = _RANGES.get(name, (55.0, 1600.0))
            notes = analysis.track_notes(outputs[name], sample_rate, fmin=low, fmax=high)
            cancel.raise_if_cancelled()
            extras["midi"][name] = _midi_writer(
                notes, extras["bpm"] or 120.0, f"{track.name} {name}"
            )

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
    return extras


def _midi_writer(notes: list, bpm: float, name: str) -> Callable[[Path], None]:
    def write(path: Path) -> None:
        write_midi(path, notes, bpm, name)

    return write
