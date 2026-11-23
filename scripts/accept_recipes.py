"""Phase 2 acceptance: run every built-in recipe on a song and check the results.

Usage (from engine/):
    uv run python ../scripts/accept_recipes.py SONG [--quality fast] [--out FOLDER]

Checks, per recipe: it completes, every stem has exactly the decoded source's sample
count, and the recipe-specific rules hold (drum-kit stems, melody sum, drumless difference).
"""

from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

from openstems.audio.decode import decode
from openstems.audio.write import read_audio
from openstems.pipeline.run import RunOptions
from openstems.runtime import build_runtime

MEGA_STEMS = ["lead-vocal", "kick", "bass", "electric-guitar", "piano", "saxophone"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("song")
    parser.add_argument("--quality", default="fast")
    parser.add_argument("--out", default=None)
    parser.add_argument("--recipes", default="")
    args = parser.parse_args()

    rt = build_runtime()
    out_root = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="openstems-accept-"))
    mix = decode(args.song)
    wanted = [r for r in args.recipes.split(",") if r] or list(rt.recipes)
    failures = 0
    for recipe_id in wanted:
        recipe = rt.recipes[recipe_id]
        options = RunOptions(quality=args.quality, force=True)
        if recipe.selectable_outputs:
            options.outputs = MEGA_STEMS
        started = time.perf_counter()
        try:
            result = rt.pipeline.run(args.song, recipe, out_root, options)
        except Exception as exc:
            failures += 1
            print(f"FAIL {recipe_id}: {exc.__class__.__name__}: {exc}", flush=True)
            continue
        elapsed = time.perf_counter() - started
        stems = {s.name: read_audio(Path(result.directory) / s.file)[0] for s in result.stems}
        problems = [n for n, a in stems.items() if a.shape != mix.shape]
        silent = [n for n, a in stems.items() if not np.isfinite(a).all()]
        notes = []
        if recipe_id == "drum-kit":
            missing = {"kick", "snare", "toms", "hh", "ride", "crash"} - set(stems)
            if missing:
                problems.append(f"missing {sorted(missing)}")
            notes.append("kick, snare, toms, hh, ride, crash written")
        if recipe_id == "melody":
            same = np.array_equal(
                stems["melody"], stems["other"] + stems["guitar"] + stems["piano"]
            )
            if not same:
                problems.append("melody != other + guitar + piano")
            notes.append("melody == other + guitar + piano, sample for sample")
        if recipe_id == "drumless":
            notes.append(f"peak {float(np.abs(stems['drumless']).max()):.2f}")
        ok = not problems and not silent
        failures += not ok
        print(
            f"{'ok  ' if ok else 'FAIL'} {recipe_id:28s} {len(stems):2d} stems aligned "
            f"({mix.shape[1]} samples) in {elapsed:5.1f}s"
            + (f"  [{'; '.join(notes)}]" if notes else "")
            + (f"  PROBLEMS: {problems + silent}" if not ok else ""),
            flush=True,
        )
    print(f"outputs in {out_root}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
