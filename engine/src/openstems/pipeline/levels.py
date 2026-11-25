"""Marks the empty stems of a set, for the API.

The verdict (`domain.levels.empty_stems`) needs each stem's peak. A run measures it and the
manifest keeps it. Stems written before that have none: theirs is read from the peaks file
drawn for the waveform, which is of the file as written (so after normalize, where a run's
own figure is from before it).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from openstems.domain.levels import empty_stems


def measure_peak(audio: np.ndarray) -> float:
    """The largest sample of a stem, over every channel."""
    return round(float(np.abs(audio).max()), 6) if audio.size else 0.0


def stored_peak(peaks_path: str | Path | None) -> float | None:
    """The peak a stem's peaks file holds, or ``None`` when there is no such file."""
    if not peaks_path:
        return None
    try:
        data = json.loads(Path(peaks_path).read_text("utf-8"))
        if "peak" in data:
            return abs(float(data["peak"]))
        # The first peaks files had no figure of their own: the largest block is it.
        return max((abs(float(value)) for value in data["data"]), default=0.0)
    except (OSError, ValueError, TypeError, KeyError):
        return None


def mark_empty(stems: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every stem of one set, each with ``empty`` set. ``peaks`` must be the full path of a
    stem's peaks file: it is read only for a stem that carries no ``peak``."""
    peaks = {
        n: stem["peak"] if stem.get("peak") is not None else stored_peak(stem.get("peaks"))
        for n, stem in enumerate(stems)
    }
    empty = empty_stems(peaks)
    for n, stem in enumerate(stems):
        stem["empty"] = n in empty
    return stems
