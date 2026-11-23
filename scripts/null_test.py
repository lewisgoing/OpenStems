"""Null test: the shared runner against the loader library's own demix_track.

At the same chunk size and overlap, the runner's output must differ from the library's
by less than -40 dB (relative to the library output's RMS).

Usage (from engine/):
    uv run python ../scripts/null_test.py SONG [--models id,id] [--seconds 60]
"""

from __future__ import annotations

import argparse
import contextlib
import io
import sys

import numpy as np
import torch
from ml_collections import ConfigDict

from openstems.audio.decode import decode
from openstems.domain.quality import RunSettings
from openstems.engines.host import engine_for
from openstems.engines.torch_common import load_yaml
from openstems.runtime import build_runtime

THRESHOLD_DB = -40.0


def library_demix(spec, config_path, module, mix: np.ndarray, device) -> dict[str, np.ndarray]:
    """Call the loader library's own chunked inference at the catalog's chunk and overlap."""
    raw = load_yaml(config_path)
    raw.setdefault("inference", {})
    raw["inference"]["chunk_size"] = spec.chunk_size
    raw["inference"]["num_overlap"] = spec.num_overlap
    config = ConfigDict(raw)
    if spec.architecture == "bs_roformer":
        from bs_roformer.utils import demix_track
    elif spec.architecture == "mel_band_roformer":
        from mel_band_roformer.utils import demix_track
    elif spec.architecture == "mdx23c":
        return mdx_library_demix(spec, raw, module, mix, device)
    else:
        raise SystemExit(f"no library reference for {spec.architecture}")
    with contextlib.redirect_stdout(io.StringIO()):
        out = demix_track(config, module, torch.tensor(mix, dtype=torch.float32), device)
    out = out[0] if isinstance(out, tuple) else out
    # The catalog may rename stems; the order is the model's.
    return dict(zip(spec.stems, out.values(), strict=True))


def mdx_library_demix(spec, raw, module, mix: np.ndarray, device) -> dict[str, np.ndarray]:
    """mdxnet-infer keeps its chunked loop inside MDX23CInference.separate."""
    from mdxnet_infer.config import MDX23CConfig
    from mdxnet_infer.inference import MDX23CInference

    raw["audio"]["chunk_size"] = spec.chunk_size
    reference = MDX23CInference.__new__(MDX23CInference)
    reference.device = device
    reference.model_name = None
    reference.config = MDX23CConfig.from_mapping(raw)
    reference.model = module
    out = reference.separate(
        mix.T, sample_rate=44100, batch_size=1, overlap=spec.num_overlap, progress=False
    )
    # The library names stems from its config and returns (samples, channels).
    return {ours: out[theirs].T for ours, theirs in zip(spec.stems, out, strict=True)}


def null_db(ours: np.ndarray, theirs: np.ndarray) -> float:
    diff = float(np.sqrt(np.mean((ours.astype(np.float64) - theirs) ** 2)))
    ref = float(np.sqrt(np.mean(theirs.astype(np.float64) ** 2)))
    if ref == 0.0:
        return -200.0 if diff == 0.0 else 0.0
    return 20 * np.log10(max(diff, 1e-12) / ref)


def run(song: str, model_ids: list[str], seconds: float) -> bool:
    rt = build_runtime()
    mix = decode(song)[:, : int(seconds * 44100)]
    ok = True
    for model_id in model_ids:
        spec = rt.catalog.get(model_id)
        with contextlib.redirect_stdout(io.StringIO()):
            loaded = engine_for(spec).load(spec, rt.store)
        config_path = rt.store.config_path(spec)
        chunk, overlap = spec.chunk_size, spec.num_overlap
        settings = RunSettings(int(chunk), int(overlap), batch_size=1, tta=False, precision="fp16")
        ours = loaded.separate(mix, settings)
        theirs = library_demix(spec, config_path, loaded.module, mix, loaded.device)
        results = {stem: null_db(ours[stem], theirs[stem]) for stem in spec.stems}
        worst = max(results, key=lambda k: results[k])
        passed = results[worst] < THRESHOLD_DB
        ok &= passed
        print(
            f"{model_id:38s} worst stem {worst:14s} null {results[worst]:7.1f} dB  "
            f"{'ok' if passed else 'FAIL'} ({len(results)} stems, chunk {chunk}, "
            f"overlap {overlap})",
            flush=True,
        )
        loaded.unload()
    return ok


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("song")
    parser.add_argument("--models", default="", help="default: every installed model")
    parser.add_argument("--seconds", type=float, default=60.0)
    args = parser.parse_args()
    chosen = [m for m in args.models.split(",") if m]
    if not chosen:
        rt = build_runtime()
        chosen = [m.id for m in rt.catalog if rt.store.is_installed(m)]
    sys.exit(0 if run(args.song, chosen, args.seconds) else 1)
