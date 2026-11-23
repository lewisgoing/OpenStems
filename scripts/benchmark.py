"""Benchmark models and presets on this machine: run time and peak VRAM.

Usage (from engine/):
    uv run python ../scripts/benchmark.py SONG [--models id,id] [--presets fast,balanced,best]
        [--batch 1,2,4] [--markdown]

Prints one row per model and preset. Paste the --markdown output into docs/benchmarks.md.
On a Mac the memory column is what the Metal driver holds after the run: MPS keeps no peak.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import time

from openstems.audio.decode import decode
from openstems.domain.quality import PRESET_NAMES, RunSettings, resolve_settings
from openstems.engines.device import (
    empty_cache,
    gpu_device_name,
    reset_peak_memory,
    synchronize,
    used_memory_bytes,
)
from openstems.engines.host import engine_for
from openstems.runtime import build_runtime


def gpu_name(device: str) -> str:
    if device == "cuda":
        import torch

        return torch.cuda.get_device_name(0)
    if device == "mps":
        from openstems.doctor import mac_gpu_name

        return mac_gpu_name()
    return "none (CPU)"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("song")
    parser.add_argument("--models", default="")
    parser.add_argument("--presets", default=",".join(PRESET_NAMES))
    parser.add_argument("--batch", default="", help="override batch sizes, e.g. 1,2,4")
    parser.add_argument("--markdown", action="store_true")
    args = parser.parse_args()

    rt = build_runtime()
    device = gpu_device_name() or "cpu"
    ids = [m for m in args.models.split(",") if m] or [
        s.id for s in rt.catalog if rt.store.is_installed(s)
    ]
    mix = decode(args.song)
    seconds = mix.shape[1] / 44100
    rows: list[dict[str, object]] = []

    for model_id in ids:
        spec = rt.catalog.get(model_id)
        empty_cache(device)
        t0 = time.perf_counter()
        with contextlib.redirect_stdout(io.StringIO()):
            loaded = engine_for(spec).load(spec, rt.store)
        load_s = time.perf_counter() - t0
        for preset in args.presets.split(","):
            base = resolve_settings(preset, spec)
            batches = [int(b) for b in args.batch.split(",") if b] or [base.batch_size]
            for batch in batches:
                settings = RunSettings(
                    base.chunk_size, base.num_overlap, batch, base.tta, base.precision
                )
                reset_peak_memory(device)
                synchronize(device)
                t0 = time.perf_counter()
                try:
                    loaded.separate(mix, settings)
                    synchronize(device)
                    run_s = time.perf_counter() - t0
                    note = ""
                except Exception as exc:
                    run_s = float("nan")
                    note = exc.__class__.__name__
                rows.append(
                    {
                        "model": model_id,
                        "preset": preset,
                        "overlap": settings.num_overlap,
                        "tta": settings.tta,
                        "batch": batch,
                        "load_s": load_s,
                        "run_s": run_s,
                        "x_realtime": seconds / run_s if run_s == run_s else 0.0,
                        "peak_vram_gb": used_memory_bytes(device) / 1024**3,
                        "note": note,
                    }
                )
                r = rows[-1]
                if not args.markdown:
                    print(
                        f"{model_id:36s} {preset:9s} ov={r['overlap']} tta={int(settings.tta)} "
                        f"b={batch} load={load_s:5.1f}s run={run_s:6.1f}s "
                        f"x{r['x_realtime']:5.1f} vram={r['peak_vram_gb']:5.2f}GB {note}",
                        flush=True,
                    )
        loaded.unload()
        del loaded

    if args.markdown:
        print(f"Song length: {seconds:.0f} s. GPU: {gpu_name(device)}.\n")
        print(
            "| Model | Preset | Overlap | TTA | Batch | Load (s) | Run (s) "
            "| x real time | Peak VRAM (GB) |"
        )
        print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for r in rows:
            print(
                f"| {r['model']} | {r['preset']} | {r['overlap']} | {'yes' if r['tta'] else 'no'} "
                f"| {r['batch']} | {r['load_s']:.1f} | {r['run_s']:.1f} | {r['x_realtime']:.1f} "
                f"| {r['peak_vram_gb']:.2f} |"
            )


if __name__ == "__main__":
    main()
