"""Decode any FFmpeg-readable file to float32 stereo through PyAV."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import av
import numpy as np
from av.error import FFmpegError

from openstems.domain.errors import Cancelled, DomainError

TARGET_RATE = 44100


class DecodeError(DomainError):
    pass


@dataclass(frozen=True)
class AudioInfo:
    sample_rate: int
    channels: int
    duration: float  # seconds, as the container reports it (0 when unknown)
    codec: str
    container: str
    bit_rate: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def probe(path: str | Path) -> AudioInfo:
    """Read metadata of the first audio stream without decoding."""
    try:
        with av.open(str(path), mode="r") as container:
            if not container.streams.audio:
                raise DecodeError(f"no audio stream in {Path(path).name}")
            stream = container.streams.audio[0]
            duration = 0.0
            if stream.duration is not None and stream.time_base is not None:
                duration = float(stream.duration * stream.time_base)
            elif container.duration is not None:
                duration = container.duration / 1_000_000
            ctx = stream.codec_context
            return AudioInfo(
                sample_rate=int(ctx.sample_rate or 0),
                channels=int(ctx.channels or 0),
                duration=max(duration, 0.0),
                codec=ctx.name,
                container=container.format.name,
                bit_rate=int(container.bit_rate or 0),
            )
    except DecodeError:
        raise
    except (FFmpegError, OSError, ValueError) as exc:
        raise DecodeError(f"cannot read {Path(path).name}: {exc}") from exc


def decode(
    path: str | Path,
    sample_rate: int = TARGET_RATE,
    progress: Callable[[float], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> np.ndarray:
    """Decode the first audio stream to float32 stereo, shape ``(2, samples)``.

    Mono is duplicated to both channels and surround is downmixed by FFmpeg.
    """
    chunks: list[np.ndarray] = []
    try:
        with av.open(str(path), mode="r") as container:
            if not container.streams.audio:
                raise DecodeError(f"no audio stream in {Path(path).name}")
            stream = container.streams.audio[0]
            total = 0.0
            if stream.duration is not None and stream.time_base is not None:
                total = float(stream.duration * stream.time_base)
            elif container.duration is not None:
                total = container.duration / 1_000_000
            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=sample_rate)
            decoded = 0
            for i, frame in enumerate(container.decode(stream)):
                if should_cancel and i % 64 == 0 and should_cancel():
                    raise Cancelled()
                for out in resampler.resample(frame):
                    block = out.to_ndarray()
                    chunks.append(block)
                    decoded += block.shape[1]
                if progress and total > 0 and i % 64 == 0:
                    progress(min(decoded / (total * sample_rate), 1.0))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray())
    except (DecodeError, Cancelled):
        raise
    except (FFmpegError, OSError, ValueError) as exc:
        raise DecodeError(f"cannot decode {Path(path).name}: {exc}") from exc

    if not chunks:
        raise DecodeError(f"{Path(path).name} decoded to no audio")
    audio = np.concatenate(chunks, axis=1).astype(np.float32, copy=False)
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    audio = np.ascontiguousarray(audio[:2])
    np.nan_to_num(audio, copy=False)
    if progress:
        progress(1.0)
    return audio


def resample(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Resample float32 ``(2, n)`` audio with FFmpeg's resampler."""
    if src_rate == dst_rate:
        return audio
    resampler = av.AudioResampler(format="fltp", layout="stereo", rate=dst_rate)
    out: list[np.ndarray] = []
    block = 1 << 16
    for start in range(0, audio.shape[1], block):
        frame = av.AudioFrame.from_ndarray(
            np.ascontiguousarray(audio[:, start : start + block]), format="fltp", layout="stereo"
        )
        frame.sample_rate = src_rate
        frame.pts = start
        out.extend(f.to_ndarray() for f in resampler.resample(frame))
    out.extend(f.to_ndarray() for f in resampler.resample(None))
    return np.ascontiguousarray(np.concatenate(out, axis=1).astype(np.float32, copy=False))
