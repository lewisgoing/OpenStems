"""Write short test media for the end-to-end suite: an MP3, a FLAC and an MP4.

Usage (from engine/):
    uv run python ../scripts/make_fixtures.py FOLDER
"""

from __future__ import annotations

import sys
from pathlib import Path

import av
import numpy as np

from openstems.audio.write import write_audio

RATE = 44100


def tone(seconds: float, freq: float) -> np.ndarray:
    t = np.arange(int(seconds * RATE), dtype=np.float64) / RATE
    left = 0.4 * np.sin(2 * np.pi * freq * t)
    right = 0.3 * np.sin(2 * np.pi * freq * 1.5 * t)
    return np.stack([left, right]).astype(np.float32)


def write_mp4(path: Path, audio: np.ndarray) -> None:
    """AAC audio in an MP4 container, standing in for a video file."""
    with av.open(str(path), mode="w", format="mp4") as out:
        stream = out.add_stream("aac", rate=RATE)
        stream.layout = "stereo"  # type: ignore[attr-defined]
        frame_size = 1024
        for start in range(0, audio.shape[1], frame_size):
            block = np.ascontiguousarray(audio[:, start : start + frame_size])
            frame = av.AudioFrame.from_ndarray(block, format="fltp", layout="stereo")
            frame.sample_rate = RATE
            frame.pts = start
            for packet in stream.encode(frame):  # type: ignore[attr-defined]
                out.mux(packet)
        for packet in stream.encode(None):  # type: ignore[attr-defined]
            out.mux(packet)


def main() -> None:
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    write_audio(folder / "First Song.mp3", tone(2.0, 220), RATE, "mp3")
    write_audio(folder / "Second Song.flac", tone(2.0, 330), RATE, "flac")
    write_mp4(folder / "Video Clip.mp4", tone(2.0, 440))
    # Spaces and non-ASCII characters, in the folder and in the file name.
    special = folder / "ünï cödé 日本語"
    special.mkdir(exist_ok=True)
    write_audio(special / "Señor Ω – 夜の曲.wav", tone(2.0, 262), RATE, "wav32f")
    print(folder)


if __name__ == "__main__":
    main()
