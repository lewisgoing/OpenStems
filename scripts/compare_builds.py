"""Check that two PyTorch builds give the same stems: run with each environment, then compare.

Used to check the AMD (ROCm) dependency set without a Radeon card: the models run on the
CPU under both builds, which exercises the loaders and the checkpoints on that PyTorch
version. It says nothing about the GPU kernels; `openstems selftest` on a Radeon does that.

    uv run python ../scripts/compare_builds.py run --out D:/tmp/cuda MODEL [MODEL ...]
    <rocm env>/Scripts/python ../scripts/compare_builds.py run --out D:/tmp/rocm MODEL ...
    uv run python ../scripts/compare_builds.py compare D:/tmp/cuda D:/tmp/rocm
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np


def run(out: Path, model_ids: list[str], seconds: float) -> None:
    os.environ["OPENSTEMS_DEVICE"] = "cpu"
    import torch

    from openstems.domain.quality import resolve_settings
    from openstems.engines.host import engine_for
    from openstems.runtime import build_runtime
    from openstems.selftest import test_signal

    out.mkdir(parents=True, exist_ok=True)
    runtime = build_runtime()
    mix = test_signal(seconds)
    np.save(out / "mix.npy", mix)
    info: dict[str, object] = {"torch": torch.__version__, "models": {}}
    for model_id in model_ids:
        spec = runtime.catalog.get(model_id)
        settings = replace(resolve_settings("fast", spec), precision="fp32")
        model = engine_for(spec).load(spec, runtime.store)
        started = time.perf_counter()
        stems = model.separate(mix, settings)
        taken = time.perf_counter() - started
        model.unload()
        for stem, audio in stems.items():
            np.save(out / f"{model_id}.{stem}.npy", audio)
        info["models"][model_id] = {"seconds": round(taken, 1), "stems": list(stems)}  # type: ignore[index]
        print(f"{model_id}: {len(stems)} stems in {taken:.1f} s on torch {torch.__version__}")
    (out / "info.json").write_text(json.dumps(info, indent=2), encoding="utf-8")


def compare(a: Path, b: Path) -> int:
    from openstems.selftest import MODEL_PASS_DB, difference_db

    mix = np.load(a / "mix.npy")
    if not np.array_equal(mix, np.load(b / "mix.npy")):
        print("the two runs used different test signals")
        return 1
    names = [json.loads((d / "info.json").read_text(encoding="utf-8"))["torch"] for d in (a, b)]
    print(f"{names[0]}  vs  {names[1]}")
    failed = 0
    for path in sorted(a.glob("*.npy")):
        if path.name == "mix.npy":
            continue
        other = b / path.name
        if not other.is_file():
            print(f"{path.stem}: missing from {b}")
            failed += 1
            continue
        db = difference_db(np.load(other), np.load(path), mix)
        ok = db <= MODEL_PASS_DB
        failed += not ok
        print(f"{path.stem:<48} {db:8.1f} dB  {'ok' if ok else 'FAILED'}")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run")
    r.add_argument("--out", type=Path, required=True)
    r.add_argument("--seconds", type=float, default=4.0)
    r.add_argument("models", nargs="+")
    c = sub.add_parser("compare")
    c.add_argument("a", type=Path)
    c.add_argument("b", type=Path)
    args = parser.parse_args()
    if args.command == "run":
        run(args.out, args.models, args.seconds)
        return 0
    return compare(args.a, args.b)


if __name__ == "__main__":
    sys.exit(main())
