"""Write stems (WAV float/24-bit, FLAC, MP3) and their peaks files."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from openstems.domain.errors import DomainError

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


def write_audio(path: Path, audio: np.ndarray, sample_rate: int, fmt: str = "wav32f") -> None:
    """Write ``(channels, samples)`` float32 audio. Float WAV is written untouched;
    fixed-point formats are clipped to [-1, 1] by libsndfile."""
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
