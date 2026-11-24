"""A song's own file, ready to be played and drawn before it is separated.

The app shows a song's waveform and beat grid while it waits in the queue, so a stretch of
it can be chosen before separation, or without it. The song may be in any format FFmpeg
reads; its preview is a 16-bit FLAC at 44.1 kHz that the app's player takes as it is, with
its peaks and the beat grid detection finds. The newest few are kept in the cache folder.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from openstems.audio.analysis import detect_grid
from openstems.audio.decode import decode
from openstems.audio.write import compute_peaks
from openstems.domain.errors import DomainError

PREVIEW_RATE = 44100
KEEP = 8
# A temporary file this old was left by a write that never finished.
_STALE_SECONDS = 600.0
_BLOCK = 1 << 18  # frames written at a time
_OURS = re.compile(r"^([0-9a-f]{24})\.(flac|peaks\.json|json)$")
_TEMPORARY = re.compile(r"^\.[0-9a-f]{24}\..*\.tmp$")


def preview_key(source: Path) -> str:
    """The name of a song's preview: its path, size and time of change, hashed, so a file
    that changes gets a new preview."""
    stat = source.stat()
    text = f"{os.path.normcase(os.path.abspath(source))}\n{stat.st_size}\n{stat.st_mtime_ns}"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def make_preview(source: Path, folder: Path, key: str) -> dict[str, Any]:
    """The preview of ``source`` in ``folder``, named ``key``: written the first time,
    found again after that. Only the ``KEEP`` newest previews stay."""
    audio_path, peaks_path, info_path = _paths(folder, key)
    info = _read_info(info_path)
    if info is not None and audio_path.is_file() and peaks_path.is_file():
        for path in (audio_path, peaks_path, info_path):
            with contextlib.suppress(OSError):
                os.utime(path)  # used again: one of the newest
    else:
        info = _write(source, folder, key)
        _prune(folder, KEEP)
    return {
        "audio": str(audio_path),
        "peaks": str(peaks_path),
        "duration": info["duration"],
        "sample_rate": info["sample_rate"],
        "analysis": info["analysis"],
    }


def _paths(folder: Path, key: str) -> tuple[Path, Path, Path]:
    return folder / f"{key}.flac", folder / f"{key}.peaks.json", folder / f"{key}.json"


def _read_info(path: Path) -> dict[str, Any] | None:
    try:
        info = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    wanted = ("duration", "sample_rate", "analysis")
    return info if isinstance(info, dict) and all(k in info for k in wanted) else None


def _write(source: Path, folder: Path, key: str) -> dict[str, Any]:
    audio = decode(source, PREVIEW_RATE)
    bpm, song_key, downbeat = detect_grid(audio, PREVIEW_RATE)
    info = {
        "source": str(source),
        "samples": int(audio.shape[1]),
        "sample_rate": PREVIEW_RATE,
        "duration": round(audio.shape[1] / PREVIEW_RATE, 6),
        "analysis": {"bpm": bpm, "key": song_key, "downbeat": downbeat},
    }
    audio_path, peaks_path, info_path = _paths(folder, key)

    def flac(tmp: Path) -> None:
        with sf.SoundFile(
            str(tmp), "w", PREVIEW_RATE, audio.shape[0], "PCM_16", format="FLAC"
        ) as f:
            for at in range(0, audio.shape[1], _BLOCK):
                f.write(np.clip(audio[:, at : at + _BLOCK].T, -1.0, 1.0))

    peaks = json.dumps(compute_peaks(audio, PREVIEW_RATE), separators=(",", ":"))
    try:
        folder.mkdir(parents=True, exist_ok=True)
        _replace(audio_path, flac)
        _replace(peaks_path, lambda tmp: tmp.write_text(peaks, "utf-8"))
        # The last one: its being there says the other two are whole.
        _replace(info_path, lambda tmp: tmp.write_text(json.dumps(info, indent=2), "utf-8"))
    except (OSError, RuntimeError) as exc:
        raise DomainError(f"cannot write the preview of {source.name}: {exc}") from exc
    return info


def _replace(path: Path, write: Callable[[Path], object]) -> None:
    """Write ``path`` under a temporary name and move it into place: a reader never sees
    half a file."""
    tmp = path.parent / f".{path.name.split('.', 1)[0]}.{uuid.uuid4().hex[:8]}.tmp"
    try:
        write(tmp)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)


def _prune(folder: Path, keep: int) -> None:
    """Keep the ``keep`` newest previews and remove the others, with any temporary file
    left by a write that never finished. Nothing but previews is ever touched."""
    newest: dict[str, float] = {}
    files: dict[str, list[Path]] = {}
    now = time.time()
    try:
        entries = list(folder.iterdir())
    except OSError:
        return
    for path in entries:
        try:
            changed = path.stat().st_mtime
        except OSError:
            continue
        if _TEMPORARY.match(path.name):
            if now - changed > _STALE_SECONDS:
                with contextlib.suppress(OSError):
                    path.unlink()
            continue
        match = _OURS.match(path.name)
        if match is None:
            continue
        key = match.group(1)
        newest[key] = max(newest.get(key, 0.0), changed)
        files.setdefault(key, []).append(path)
    for key in sorted(newest, key=newest.__getitem__, reverse=True)[keep:]:
        for path in files[key]:
            with contextlib.suppress(OSError):  # a file being played stays (Windows)
                path.unlink()
