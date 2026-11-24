"""Write stems (WAV float/24-bit, FLAC, MP3) and their peaks files."""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from openstems.domain.errors import DomainError
from openstems.domain.tempo import carries_tempo

# format id -> (extension, libsndfile format, subtype)
FORMATS: dict[str, tuple[str, str, str]] = {
    "wav32f": (".wav", "WAV", "FLOAT"),
    "wav24": (".wav", "WAV", "PCM_24"),
    "flac": (".flac", "FLAC", "PCM_24"),
    "mp3": (".mp3", "MP3", "MPEG_LAYER_III"),
}
PEAKS_TARGET_POINTS = 4000
PEAKS_MIN_BLOCK = 256


def extension(fmt: str) -> str:
    try:
        return FORMATS[fmt][0]
    except KeyError:
        raise DomainError(f"unknown output format {fmt!r}") from None


def tempo_chunk(bpm: float) -> bytes:
    """The ``acid`` chunk that makes FL Studio stretch a WAV to the project's tempo.

    FL Studio 2026 reads the tempo and nothing else: a file with a tempo and no beat count
    is synced, one with a beat count and no tempo is not (tried in FL on 2026-11-23). The
    other fields are what FL writes itself: the "stretch" flag, root note C5, 4/4. The beat
    count is left at 0, since a whole song is rarely a whole number of beats long.
    """
    return b"acid" + struct.pack("<IIHHfIHHf", 24, 0x04, 60, 0x80, 0.0, 0, 4, 4, bpm)


def _append_chunk(path: Path, chunk: bytes) -> None:
    with path.open("r+b") as f:
        head = f.read(12)
        if head[:4] != b"RIFF" or head[8:] != b"WAVE":
            return
        end = f.seek(0, 2)
        if end & 1:
            f.write(b"\x00")
            end += 1
        if end + len(chunk) - 8 > 0xFFFFFFFF:
            return
        f.write(chunk)
        f.seek(4)
        f.write(struct.pack("<I", end + len(chunk) - 8))


def _find_chunk(f: Any, name: bytes) -> tuple[int, int] | None:
    """Where a chunk of a RIFF WAV starts (its header) and how long its data is."""
    f.seek(0)
    head = f.read(12)
    if head[:4] != b"RIFF" or head[8:] != b"WAVE":
        return None
    at = 12
    while True:
        f.seek(at)
        header = f.read(8)
        if len(header) < 8:
            return None
        size = struct.unpack("<I", header[4:])[0]
        if header[:4] == name:
            return at, size
        at += 8 + size + (size & 1)


def set_tempo(path: Path, bpm: float | None) -> None:
    """Change the tempo a WAV is marked with (see `tempo_chunk`), without touching its
    audio. None takes the mark away: FL Studio does not sync a file whose tempo is 0."""
    wanted = bpm if bpm and bpm > 0 else 0.0
    with path.open("r+b") as f:
        found = _find_chunk(f, b"acid")
        if found is not None and found[1] == 24:
            f.seek(found[0])
            f.write(tempo_chunk(wanted))
            return
    if found is None and wanted:
        _append_chunk(path, tempo_chunk(wanted))


def write_audio(
    path: Path, audio: np.ndarray, sample_rate: int, fmt: str = "wav32f", bpm: float | None = None
) -> None:
    """Write ``(channels, samples)`` float32 audio. Float WAV is written untouched;
    fixed-point formats are clipped to [-1, 1] by libsndfile. With ``bpm``, a WAV is
    marked as tempo-synced for FL Studio; FLAC and MP3 cannot carry the mark."""
    if fmt not in FORMATS:
        raise DomainError(f"unknown output format {fmt!r}")
    _, container, subtype = FORMATS[fmt]
    data = np.ascontiguousarray(audio.T)
    if fmt != "wav32f":
        data = np.clip(data, -1.0, 1.0)
    kwargs = {}
    if fmt == "mp3":
        kwargs = {"compression_level": 0.0, "bitrate_mode": "CONSTANT"}  # 320 kbps
    sf.write(str(path), data, sample_rate, format=container, subtype=subtype, **kwargs)
    if bpm and bpm > 0 and carries_tempo(fmt):
        _append_chunk(path, tempo_chunk(bpm))


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    """Read a file written by :func:`write_audio` back as ``(channels, samples)`` float32."""
    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(data.T), int(rate)


def compute_peaks(audio: np.ndarray, sample_rate: int) -> dict[str, Any]:
    """Min/max pairs per block of the mono sum, sized for a waveform a few thousand px wide."""
    samples = audio.shape[1]
    block = max(PEAKS_MIN_BLOCK, math.ceil(samples / PEAKS_TARGET_POINTS)) if samples else 1
    mono = audio.mean(axis=0) if audio.shape[0] > 1 else audio[0]
    count = math.ceil(samples / block) if samples else 0
    padded = np.zeros(count * block, dtype=np.float32)
    padded[:samples] = mono
    blocks = padded.reshape(count, block) if count else padded.reshape(0, 1)
    lo = blocks.min(axis=1) if count else np.zeros(0, dtype=np.float32)
    hi = blocks.max(axis=1) if count else np.zeros(0, dtype=np.float32)
    data = np.empty(count * 2, dtype=np.float32)
    data[0::2] = lo
    data[1::2] = hi
    return {
        "version": 1,
        "sample_rate": sample_rate,
        "samples": samples,
        "samples_per_peak": block,
        "length": count,
        "peak": round(float(np.abs(mono).max()) if samples else 0.0, 5),
        "data": [round(float(v), 4) for v in data],
    }


def write_peaks(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    path.write_text(json.dumps(compute_peaks(audio, sample_rate), separators=(",", ":")), "utf-8")
