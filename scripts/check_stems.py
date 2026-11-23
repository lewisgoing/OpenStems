"""Check a stem folder against its source: alignment and, optionally, sum-to-mix.

Usage (from engine/):
    uv run python ../scripts/check_stems.py OUTPUT_FOLDER [--sum-to-mix] [--equals STEM=A+B+C]

Alignment: every stem has exactly the decoded source's sample count.
Sum-to-mix: the stems sum to the decoded mix within -60 dB.
Equals: a stem equals the sample-for-sample sum of other stems.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from openstems.audio.decode import decode
from openstems.audio.write import read_audio


def db(x: np.ndarray, ref: np.ndarray) -> float:
    num = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    den = float(np.sqrt(np.mean(ref.astype(np.float64) ** 2)))
    return 20 * np.log10(max(num, 1e-12) / max(den, 1e-12))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("folder")
    parser.add_argument("--sum-to-mix", action="store_true")
    parser.add_argument("--equals", action="append", default=[])
    args = parser.parse_args()

    folder = Path(args.folder)
    manifest = json.loads((folder / "manifest.json").read_text("utf-8"))
    mix = decode(manifest["source"]["path"])
    ok = True
    stems: dict[str, np.ndarray] = {}
    for stem in manifest["stems"]:
        audio, rate = read_audio(folder / stem["file"])
        stems[stem["name"]] = audio
        aligned = audio.shape == mix.shape and rate == 44100
        ok &= aligned
        print(
            f"{'ok  ' if aligned else 'FAIL'} {stem['name']:12s} {audio.shape[1]} samples "
            f"(source {mix.shape[1]})"
        )
    if args.sum_to_mix:
        residual = db(mix - sum(stems.values()), mix)
        passed = residual < -60
        ok &= passed
        print(f"{'ok  ' if passed else 'FAIL'} stems sum to the mix: residual {residual:.1f} dB")
    for rule in args.equals:
        name, _, expr = rule.partition("=")
        total = sum(stems[part] for part in expr.split("+"))
        same = bool(np.array_equal(stems[name], total))
        ok &= same
        print(f"{'ok  ' if same else 'FAIL'} {name} == {expr} sample for sample")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
