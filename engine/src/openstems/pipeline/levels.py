"""Marks the empty stems of a set, for the API.

The verdict (`domain.levels.empty_stems`) needs each stem's peak. A run measures it and the
manifest keeps it. Stems written before that have none: theirs is read from the peaks file
drawn for the waveform, which is of the file as written (so after normalize, where a run's
own figure is from before it).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import numpy as np

from openstems.domain.errors import DomainError
from openstems.domain.levels import empty_stems
from openstems.domain.stem import MANIFEST_NAME


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


def set_hidden(directory: Path, choices: dict[str, bool | None]) -> dict[str, Any]:
    """Keep the user's choice for stems of the set in ``directory``: True leaves a stem out
    of the app's lists, False keeps it in though it is empty, None takes the choice away.

    ``choices`` maps stem names to it; stems it does not name stay as they are. Only the
    manifest changes, so the choice goes wherever the stems go. Returns the new manifest.
    """
    from openstems.pipeline.run import read_manifest

    manifest = read_manifest(directory)
    if manifest is None:
        raise DomainError("that folder does not hold a set of stems")
    stems = {str(stem["name"]): stem for stem in manifest.get("stems", [])}
    unknown = [name for name in choices if name not in stems]
    if unknown:
        raise DomainError(f"not a stem of this song: {unknown[0]}")
    changed = False
    for name, choice in choices.items():
        if stems[name].get("hidden") == choice:
            continue
        changed = True
        if choice is None:
            stems[name].pop("hidden", None)
        else:
            stems[name]["hidden"] = bool(choice)
    if not changed:
        return manifest
    tmp = directory / (MANIFEST_NAME + ".tmp")
    try:
        tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, directory / MANIFEST_NAME)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise DomainError(f"cannot save the choice: {exc.strerror or exc}") from exc
    return manifest
