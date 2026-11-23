"""A mix of some of a song's stems, as one file: everything but the vocals, drums and bass
together, and so on.

The stems are read back from disk and summed as they are, so the mix is what the same stems
sound like played together. It is written next to them, in a ``Mixes`` folder, in the stems'
own format and named by the stems' own naming template.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

import numpy as np

from openstems.audio.write import FORMATS, extension, read_audio, write_audio
from openstems.domain.errors import DomainError
from openstems.domain.naming import DEFAULT_TEMPLATE, render_name, safe_component
from openstems.pipeline.run import SAMPLE_RATE, read_manifest

MIXES_DIR = "Mixes"


def mix_label(chosen: list[str], every: list[str]) -> str:
    """The mix in a few words, for its file name: ``no vocals``, ``drums + bass``."""
    left_out = [name for name in every if name not in chosen]
    if not left_out:
        return "mix"
    if len(left_out) == 1:
        return f"no {left_out[0]}"
    if len(chosen) <= 3:
        return " + ".join(chosen)
    if len(left_out) <= 3:
        return "no " + ", ".join(left_out)
    return f"{len(chosen)} stems"


def render_mix(directory: Path, files: list[str]) -> dict[str, Any]:
    """Sum the named stem files of the stem set in ``directory`` and write the result.

    ``files`` are file names from the folder's manifest. Returns the mix's path and what is
    in it. The same choice of stems writes the same file again, so a mix made after the song
    was separated anew is never an old one.
    """
    manifest = read_manifest(directory)
    if manifest is None:
        raise DomainError("that folder does not hold a set of stems")
    stems: list[dict[str, Any]] = list(manifest.get("stems", []))
    by_file = {str(stem["file"]): stem for stem in stems}
    wanted = list(dict.fromkeys(files))
    unknown = [name for name in wanted if name not in by_file]
    if unknown:
        raise DomainError(f"not a stem of this song: {unknown[0]}")
    if len(wanted) < 2:
        raise DomainError("a mix needs at least two stems")
    # In the song's own stem order, whatever order they were asked for in.
    chosen = [stem for stem in stems if stem["file"] in wanted]

    rate = 0
    channels = 0
    parts: list[tuple[int, np.ndarray]] = []
    for stem in chosen:
        try:
            audio, stem_rate = read_audio(directory / stem["file"])
        except Exception as exc:
            raise DomainError(f"cannot read {stem['file']}: {exc}") from exc
        if rate and stem_rate != rate:
            raise DomainError("these stems have different sample rates and cannot be mixed")
        rate = stem_rate
        channels = max(channels, audio.shape[0])
        # A stem whose silence was trimmed starts later than the song does. The offset is
        # counted at the engine's rate; the file may be at the source's.
        start = round(int(stem.get("offset") or 0) * rate / SAMPLE_RATE)
        parts.append((start, audio))

    first = min(start for start, _ in parts)
    length = max(start - first + audio.shape[1] for start, audio in parts)
    total = np.zeros((channels, length), dtype=np.float32)
    for start, audio in parts:
        at = start - first
        if audio.shape[0] < channels:
            audio = np.repeat(audio, channels, axis=0)[:channels]
        total[:, at : at + audio.shape[1]] += audio

    options = manifest.get("options") or {}
    fmt = str(options.get("format"))
    if fmt not in FORMATS:
        fmt = "wav32f"
    source = manifest.get("source") or {}
    analysis = manifest.get("analysis") or {}
    label = mix_label([s["name"] for s in chosen], [s["name"] for s in stems])
    name = render_name(
        str(options.get("template") or DEFAULT_TEMPLATE),
        stem=label,
        track=str(source.get("name") or directory.parent.name),
        recipe=str((manifest.get("recipe") or {}).get("id") or ""),
        bpm=str(analysis.get("bpm") or ""),
        key=str(analysis.get("key") or ""),
    )
    folder = directory / MIXES_DIR
    folder.mkdir(exist_ok=True)
    target = folder / (safe_component(name) + extension(fmt))
    # Written under another name first: a DAW may hold the earlier file open, and a reader
    # must never see half a file.
    tmp = folder / f".{uuid.uuid4().hex[:8]}{extension(fmt)}"
    try:
        write_audio(tmp, total, rate, fmt)
        os.replace(tmp, target)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise DomainError(f"cannot write the mix: {exc}") from exc
    return {
        "path": str(target),
        "name": target.name,
        "label": label,
        "stems": [s["name"] for s in chosen],
        "samples": int(length),
        "sample_rate": int(rate),
    }
