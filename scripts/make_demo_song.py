"""Write a synthetic demo song and its parts, for the README screenshots.

The FakeEngine returns scaled copies of the input, so every stem's waveform looks the same.
This script draws a song from six synthesized parts (vocals, drums, bass, guitar, piano,
other) instead. With ``mix`` it writes the sum of the parts as an MP3 to drop on the app; with
``stems`` it writes the parts over the stems the FakeEngine left in a stem folder. No real
recording is involved, so the pictures can be published.

Usage (from engine/):
    uv run python ../scripts/make_demo_song.py mix FOLDER NAME SEED
    uv run python ../scripts/make_demo_song.py stems STEM_FOLDER NAME SEED
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

from openstems.audio.write import write_audio, write_peaks

RATE = 44100
STEMS = ("vocals", "drums", "bass", "guitar", "piano", "other")
# Chord roots (Hz) of a four-bar loop, one per song.
LOOPS = ((110.0, 87.3, 130.8, 98.0), (146.8, 116.5, 98.0, 130.8), (123.5, 98.0, 146.8, 110.0))


def hits(
    total: int, starts: np.ndarray, decay: float, rng: np.random.Generator, spread: float = 0.0
) -> np.ndarray:
    """An envelope with a decaying hit at each start (in samples)."""
    env = np.zeros(total, dtype=np.float64)
    length = int(decay * 6 * RATE)
    shape = np.exp(-np.arange(length) / (decay * RATE))
    for start in starts.astype(int):
        end = min(total, start + length)
        level = 1.0 - spread * rng.random()
        if start < total:
            env[start:end] = np.maximum(env[start:end], level * shape[: end - start])
    return env


def sections(total: int, bar: int, pattern: str) -> np.ndarray:
    """A gate that is open in the eight-bar blocks marked 'x', with short fades."""
    gate = np.zeros(total, dtype=np.float64)
    for i, mark in enumerate(pattern):
        if mark != "-":
            gate[i * 8 * bar : (i + 1) * 8 * bar] = 1.0 if mark == "x" else 0.55
    fade = np.hanning(RATE // 5)
    return np.convolve(gate, fade / fade.sum(), mode="same")


def parts(seed: int) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    bpm = (120, 96, 128)[seed % 3]
    loop = LOOPS[seed % 3]
    beat = int(RATE * 60 / bpm)
    bar = beat * 4
    blocks = (12, 10, 13)[seed % 3]
    total = blocks * 8 * bar
    t = np.arange(total) / RATE
    root = np.repeat(np.resize(np.array(loop), total // bar + 1), bar)[:total]
    phase = 2 * np.pi * np.cumsum(root) / RATE
    beats = np.arange(0, total, beat)

    arrangement = (
        {
            "vocals": "--xxo-xxo-xx",
            "drums": "-xxxx-xxxxxo",
            "bass": "-oxxx-xxoxxo",
            "guitar": "x-oxx--xxoxx",
            "piano": "oo--xxo--xxo",
            "other": "xooxoxooxoxx",
        },
        {
            "vocals": "-xx-xxo-xx",
            "drums": "--xxxx-xxo",
            "bass": "-xxxxxoxxo",
            "guitar": "--ox-xx-xx",
            "piano": "xxo-oxxxox",
            "other": "oxooxoxoxx",
        },
        {
            "vocals": "--xx-xxo-xxx-",
            "drums": "-xxxxxx-oxxxo",
            "bass": "--xxxxx-xxxxo",
            "guitar": "---xx-xx--xx-",
            "piano": "xo---xo-xx-xo",
            "other": "xoxoxoxxoxoxx",
        },
    )[seed % 3]

    kick = hits(total, beats, 0.05, rng) * np.sin(2 * np.pi * 52 * t)
    snare = hits(total, beats[1::2], 0.045, rng, 0.2) * rng.standard_normal(total) * 0.5
    hat = (
        hits(total, np.arange(0, total, beat // 2), 0.012, rng, 0.6)
        * rng.standard_normal(total)
        * 0.18
    )
    drums = (kick + snare + hat) * 0.7

    bass_env = hits(
        total,
        np.arange(0, total, beat // 2)[
            rng.random(total // (beat // 2) + 1)[: len(np.arange(0, total, beat // 2))] < 0.7
        ],
        0.16,
        rng,
        0.3,
    )
    bass = bass_env * (np.sin(phase / 2) + 0.3 * np.sin(phase)) * 0.5

    # Sung phrases: two bars on, a breath, with the level moving inside the phrase.
    phrase = np.zeros(total)
    for start in range(0, total, 2 * bar):
        length = int((1.1 + 0.7 * rng.random()) * bar)
        offset = int(rng.random() * beat)
        end = min(total, start + offset + length)
        n = end - start - offset
        if n > 0:
            phrase[start + offset : end] = np.sin(np.pi * np.arange(n) / n) ** 0.4 * (
                0.6 + 0.4 * rng.random()
            )
    syllables = 0.65 + 0.35 * np.abs(np.sin(2 * np.pi * t * bpm / 60 * (1 + 0.5 * np.sin(t / 7))))
    vibrato = 0.012 * np.sin(2 * np.pi * 5.5 * t)
    vocals = (
        phrase * syllables * (np.sin(phase * 3 + vibrato * 60) + 0.4 * np.sin(phase * 6)) * 0.42
    )

    strum = hits(
        total,
        np.arange(0, total, beat // 2)[rng.random(len(np.arange(0, total, beat // 2))) < 0.8],
        0.09,
        rng,
        0.5,
    )
    guitar = (
        strum * (np.sin(phase * 2) + 0.5 * np.sin(phase * 3) + 0.3 * np.sin(phase * 4.01)) * 0.3
    )

    chord = hits(
        total,
        np.arange(0, total, bar // 2)[rng.random(len(np.arange(0, total, bar // 2))) < 0.85],
        0.45,
        rng,
        0.4,
    )
    piano = (
        chord * (np.sin(phase * 2) + 0.6 * np.sin(phase * 2.52) + 0.5 * np.sin(phase * 3)) * 0.24
    )

    swell = 0.5 + 0.5 * np.sin(2 * np.pi * t / (8 * bar / RATE) - np.pi / 2)
    other = (
        (0.35 + 0.65 * swell) * (np.sin(phase * 1.5) + 0.5 * np.sin(phase * 4 + np.sin(t))) * 0.16
    )

    raw = {
        "vocals": vocals,
        "drums": drums,
        "bass": bass,
        "guitar": guitar,
        "piano": piano,
        "other": other,
    }
    out: dict[str, np.ndarray] = {}
    for name, signal in raw.items():
        mono = signal * sections(total, bar, arrangement[name])
        width = {
            "vocals": 0.0,
            "drums": 0.1,
            "bass": 0.0,
            "guitar": 0.35,
            "piano": -0.3,
            "other": 0.2,
        }[name]
        out[name] = np.stack([mono * (1 - width), mono * (1 + width)]).astype(np.float32)
    return out


def main() -> None:
    mode, folder, name, seed = sys.argv[1], Path(sys.argv[2]), sys.argv[3], int(sys.argv[4])
    song = parts(seed)
    if mode == "mix":
        folder.mkdir(parents=True, exist_ok=True)
        mix = np.sum(list(song.values()), axis=0)
        write_audio(
            folder / f"{name}.mp3",
            (mix / max(1.0, float(np.abs(mix).max()))).astype(np.float32),
            RATE,
            "mp3",
        )
        return
    (folder / ".peaks").mkdir(exist_ok=True)
    for stem in STEMS:
        target = folder / f"{name} - {stem}.wav"
        if target.exists():
            write_audio(target, song[stem], RATE, "wav32f")
            write_peaks(folder / ".peaks" / f"{stem}.json", song[stem], RATE)


if __name__ == "__main__":
    main()
