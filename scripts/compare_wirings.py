"""Compare the two wirings of full-song-best-vocals against ground-truth stems.

Usage (from engine/):
    uv run python ../scripts/compare_wirings.py MUSDB_FOLDER [--tracks 50] [--quality balanced]

MUSDB_FOLDER holds one folder per track with mixture.wav, vocals.wav, drums.wav, bass.wav
and other.wav (the MUSDB18 layout; the 7-second excerpts from Zenodo record 3270814 work).

Both wirings share the vocal stem (Leap Xe on the mix), so the comparison is about the
instruments: SW on the mix against SW on the Leap Xe instrumental. MUSDB's "other" holds
everything that is not vocals, drums or bass, so it is scored against other + guitar + piano.
SDR is 10 * log10(|reference|^2 / |reference - estimate|^2), in dB; higher is better.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

import numpy as np

from openstems.audio.decode import decode
from openstems.audio.write import read_audio
from openstems.pipeline.run import RunOptions
from openstems.runtime import build_runtime

WIRINGS = {
    "SW on the mix": "full-song-best-vocals",
    "SW on the instrumental": "full-song-best-vocals-alt",
}
TARGETS = ("vocals", "drums", "bass", "other")


def sdr(reference: np.ndarray, estimate: np.ndarray) -> float:
    n = min(reference.shape[1], estimate.shape[1])
    ref, est = reference[:, :n].astype(np.float64), estimate[:, :n].astype(np.float64)
    return float(10 * np.log10((np.sum(ref**2) + 1e-9) / (np.sum((ref - est) ** 2) + 1e-9)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("folder")
    parser.add_argument("--tracks", type=int, default=50)
    parser.add_argument("--quality", default="balanced")
    args = parser.parse_args()

    rt = build_runtime()
    # Keep one model on the GPU at a time, so this also runs while other apps hold VRAM.
    rt.pipeline.host.budget = 0
    tracks = sorted(p for p in Path(args.folder).iterdir() if (p / "mixture.wav").is_file())
    tracks = tracks[: args.tracks]
    if not tracks:
        print("no tracks with mixture.wav found")
        return 2
    out_root = Path(tempfile.mkdtemp(prefix="openstems-wirings-"))
    scores: dict[str, dict[str, list[float]]] = {w: {t: [] for t in TARGETS} for w in WIRINGS}
    used = 0
    for index, track in enumerate(tracks):
        refs = {t: decode(track / f"{t}.wav") for t in TARGETS}
        # A target that is silent in this excerpt has no meaningful SDR: skip the track.
        if any(float(np.abs(r).max()) < 1e-3 for r in refs.values()):
            continue
        used += 1
        for wiring, recipe_id in WIRINGS.items():
            result = rt.pipeline.run(
                track / "mixture.wav",
                rt.recipes[recipe_id],
                out_root / f"{index:03d}",
                RunOptions(quality=args.quality, force=True),
            )
            stems = {s.name: read_audio(Path(result.directory) / s.file)[0] for s in result.stems}
            estimates = {
                "vocals": stems["vocals"],
                "drums": stems["drums"],
                "bass": stems["bass"],
                "other": stems["other"] + stems["guitar"] + stems["piano"],
            }
            for target in TARGETS:
                scores[wiring][target].append(sdr(refs[target], estimates[target]))
        print(f"{used:3d} {track.name[:50]}", flush=True)

    print(f"\n{used} tracks, quality {args.quality}. Median SDR in dB (mean in brackets):\n")
    print("| Wiring | vocals | drums | bass | other | instruments (mean of three) |")
    print("| --- | --- | --- | --- | --- | --- |")
    for wiring in WIRINGS:
        cells = [
            f"{np.median(scores[wiring][t]):.2f} ({np.mean(scores[wiring][t]):.2f})"
            for t in TARGETS
        ]
        inst = np.mean([np.median(scores[wiring][t]) for t in ("drums", "bass", "other")])
        print(f"| {wiring} | {' | '.join(cells)} | {inst:.2f} |")
    a, b = (scores[w] for w in WIRINGS)
    wins = {t: int(np.sum(np.array(a[t]) > np.array(b[t]))) for t in ("drums", "bass", "other")}
    print(f"\nTracks where SW on the mix scores higher: {wins} of {used}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
