"""GPU self-test: run the same work on the GPU and on the CPU and compare the results.

``doctor`` says whether a GPU is there. This says whether it computes the right thing, which
matters most on backends that are not tested on every release (AMD's ROCm build on Windows).
Two levels:

- ops: each kind of operation the separation models use, with fixed random inputs;
- models: one short separation per installed model, on both devices.

The CPU result is the reference. Nothing here needs a song: the input is a seeded signal.
"""

from __future__ import annotations

import copy
import math
import os
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
from typing import Any

import numpy as np

RATE = 44100
FP32_TOLERANCE = 1e-3  # largest error relative to the largest reference value
CONV_TOLERANCE = 5e-3  # GPU convolutions may use a faster, slightly less exact mode
FP16_TOLERANCE = 5e-2
MODEL_PASS_DB = -40.0  # GPU vs CPU at full precision; same bar as scripts/null_test.py
HALF_PRECISION_PASS_DB = -30.0  # GPU as the app runs it (autocast) vs the CPU


@dataclass
class OpResult:
    name: str
    ok: bool
    error: float | None = None  # relative; None when the op raised
    detail: str = ""


@dataclass
class ModelResult:
    id: str
    ok: bool
    difference_db: float | None = None  # GPU vs CPU, both at full precision
    half_precision_db: float | None = None  # GPU as the app runs it vs CPU
    gpu_seconds: float | None = None
    cpu_seconds: float | None = None
    detail: str = ""


@dataclass
class SelfTestReport:
    torch: str | None = None
    gpu_backend: str | None = None
    gpu_backend_version: str | None = None
    gpu_name: str | None = None
    gpu_available: bool = False
    ops: list[OpResult] = field(default_factory=list)
    models: list[ModelResult] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return (
            self.gpu_available
            and not self.problems
            and all(r.ok for r in self.ops)
            and all(r.ok for r in self.models)
        )

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe: an infinite number is not valid JSON."""
        data = {**asdict(self), "ok": self.ok}
        for op in data["ops"]:
            op["error"] = _finite(op["error"])
        for model in data["models"]:
            for key in ("difference_db", "half_precision_db"):
                model[key] = _finite(model[key])
        return data


def _finite(value: float | None) -> float | None:
    """Identical results (minus infinity dB) become -300; an unusable number becomes None."""
    if value is None or math.isnan(value) or value == float("inf"):
        return None
    return max(value, -300.0)


def relative_error(got: np.ndarray, expected: np.ndarray) -> float:
    """Largest absolute difference, relative to the largest reference value."""
    if got.shape != expected.shape:
        return float("inf")
    if not np.all(np.isfinite(got)):
        return float("inf")
    scale = float(np.max(np.abs(expected))) or 1.0
    return float(np.max(np.abs(got - expected))) / scale


def difference_db(got: np.ndarray, expected: np.ndarray, scale: np.ndarray | None = None) -> float:
    """Energy of the difference in dB (lower is closer), relative to ``scale`` (default: the
    reference itself)."""
    if got.shape != expected.shape or not np.all(np.isfinite(got)):
        return float("inf")
    base = expected if scale is None else scale
    reference = float(np.sum(base.astype(np.float64) ** 2))
    error = float(np.sum((got.astype(np.float64) - expected.astype(np.float64)) ** 2))
    if error == 0.0:
        return float("-inf")
    if reference == 0.0:
        return float("inf")
    return 10.0 * float(np.log10(error / reference))


def test_signal(seconds: float) -> np.ndarray:
    """Seeded stereo test signal: a few tones, a click train and noise."""
    n = int(seconds * RATE)
    t = np.arange(n, dtype=np.float64) / RATE
    rng = np.random.default_rng(11)
    left = 0.25 * np.sin(2 * np.pi * 110.0 * t) + 0.2 * np.sin(2 * np.pi * 660.0 * t)
    right = 0.25 * np.sin(2 * np.pi * 220.0 * t) + 0.2 * np.sin(2 * np.pi * 990.0 * t)
    clicks = np.zeros(n)
    clicks[:: RATE // 2] = 0.6
    noise = 0.05 * rng.standard_normal((2, n))
    return (np.stack([left + clicks, right + clicks]) + noise).astype(np.float32)


# -- ops ------------------------------------------------------------------------------


def _op_cases() -> list[tuple[str, Callable[[Any], Any], float]]:
    """(name, fn(device) -> tensor, tolerance). Each fn builds its inputs from a fixed seed
    on the CPU and moves them, so both devices see identical numbers."""
    import torch
    import torch.nn.functional as F

    def seeded(*shape: int) -> Any:
        return torch.randn(*shape, generator=torch.Generator().manual_seed(3))

    def module(make: Callable[[], Any]) -> Any:
        torch.manual_seed(5)
        return make().eval()

    def stft(device: Any) -> Any:
        window = torch.hann_window(2048).to(device)
        out = torch.stft(seeded(2, 44100).to(device), 2048, 441, window=window, return_complex=True)
        return torch.view_as_real(out)

    def istft(device: Any) -> Any:
        window = torch.hann_window(2048).to(device)
        spec = torch.stft(
            seeded(2, 44100).to(device), 2048, 441, window=window, return_complex=True
        )
        return torch.istft(spec, 2048, 441, window=window, length=44100)

    def complex_mask(device: Any) -> Any:
        a = torch.view_as_complex(seeded(2, 512, 64, 2).to(device).contiguous())
        b = torch.view_as_complex((seeded(2, 512, 64, 2) * 0.5).to(device).contiguous())
        return torch.view_as_real(a * b)

    def with_module(make: Callable[[], Any], x: Callable[[], Any]) -> Callable[[Any], Any]:
        def run(device: Any) -> Any:
            return copy.deepcopy(module(make)).to(device)(x().to(device))

        return run

    def attention(device: Any) -> Any:
        q, k, v = (seeded(2, 8, 256, 64).to(device) * s for s in (1.0, 0.7, 0.4))
        return F.scaled_dot_product_attention(q, k, v)

    def einsum(device: Any) -> Any:
        return torch.einsum(
            "bnd,bmd->bnm", seeded(4, 128, 64).to(device), seeded(4, 96, 64).to(device)
        )

    def half_precision(device: Any) -> Any:
        layer = copy.deepcopy(module(lambda: torch.nn.Linear(256, 256))).to(device)
        x = seeded(8, 128, 256).to(device)
        if torch.device(device).type != "cuda":
            return layer(x)
        with torch.autocast(device_type="cuda"):
            return layer(x).float()

    nn = torch.nn
    return [
        ("stft", stft, FP32_TOLERANCE),
        ("istft", istft, FP32_TOLERANCE),
        ("complex multiply", complex_mask, FP32_TOLERANCE),
        (
            "conv1d",
            with_module(lambda: nn.Conv1d(8, 16, 7, padding=3), lambda: seeded(2, 8, 4096)),
            CONV_TOLERANCE,
        ),
        (
            "conv2d",
            with_module(lambda: nn.Conv2d(4, 32, 3, padding=1), lambda: seeded(2, 4, 256, 128)),
            CONV_TOLERANCE,
        ),
        (
            "conv_transpose2d",
            with_module(
                lambda: nn.ConvTranspose2d(32, 16, 2, stride=2), lambda: seeded(2, 32, 64, 64)
            ),
            CONV_TOLERANCE,
        ),
        (
            "group_norm",
            with_module(lambda: nn.GroupNorm(4, 32), lambda: seeded(2, 32, 64, 64)),
            FP32_TOLERANCE,
        ),
        (
            "instance_norm",
            with_module(lambda: nn.InstanceNorm2d(32, affine=True), lambda: seeded(2, 32, 64, 64)),
            FP32_TOLERANCE,
        ),
        (
            "linear + gelu",
            with_module(
                lambda: nn.Sequential(nn.Linear(256, 512), nn.GELU(), nn.Linear(512, 256)),
                lambda: seeded(4, 128, 256),
            ),
            FP32_TOLERANCE,
        ),
        (
            "layer_norm",
            with_module(lambda: nn.LayerNorm(256), lambda: seeded(4, 128, 256)),
            FP32_TOLERANCE,
        ),
        ("attention", attention, FP32_TOLERANCE),
        ("einsum", einsum, FP32_TOLERANCE),
        ("half precision (autocast)", half_precision, FP16_TOLERANCE),
    ]


def run_op_checks() -> list[OpResult]:
    import torch

    results: list[OpResult] = []
    with torch.inference_mode():
        for name, fn, tolerance in _op_cases():
            try:
                expected = fn("cpu").numpy()
                got = fn("cuda").cpu().numpy()
                torch.cuda.synchronize()
            except Exception as exc:
                results.append(OpResult(name, False, None, f"{type(exc).__name__}: {exc}"))
                continue
            error = relative_error(got, expected)
            ok = error <= tolerance
            results.append(OpResult(name, ok, error, "" if ok else f"over {tolerance:g}"))
    return results


# -- models ---------------------------------------------------------------------------


@contextmanager
def _device(name: str) -> Iterator[None]:
    """Pin ``pick_device`` for the models loaded inside the block."""
    before = os.environ.get("OPENSTEMS_DEVICE")
    os.environ["OPENSTEMS_DEVICE"] = name
    try:
        yield
    finally:
        if before is None:
            os.environ.pop("OPENSTEMS_DEVICE", None)
        else:
            os.environ["OPENSTEMS_DEVICE"] = before


def default_models(catalog: Any, store: Any) -> list[Any]:
    """The first installed model of each architecture: one run per code path."""
    chosen: dict[str, Any] = {}
    for spec in catalog:
        if spec.architecture not in chosen and store.is_installed(spec):
            chosen[spec.architecture] = spec
    return list(chosen.values())


def check_model(spec: Any, store: Any, seconds: float, quality: str = "fast") -> ModelResult:
    """Separate a short signal three ways: CPU (the reference), GPU at full precision, and
    GPU the way the app runs it (half precision where the preset asks for it)."""
    import torch

    from openstems.domain.quality import resolve_settings
    from openstems.engines.host import engine_for

    preset = resolve_settings(quality, spec)
    full = replace(preset, precision="fp32")
    mix = test_signal(seconds)
    result = ModelResult(spec.id, False)

    def run(device: str, settings: Any) -> dict[str, np.ndarray]:
        with _device(device):
            model = engine_for(spec).load(spec, store)
        try:
            started = time.perf_counter()
            out = model.separate(mix, settings)
            if device == "cuda":
                torch.cuda.synchronize()
            taken = time.perf_counter() - started
        finally:
            model.unload()
        if device == "cpu":
            result.cpu_seconds = taken
        elif settings is preset:
            result.gpu_seconds = taken
        return out

    steps = [("GPU", "cuda", preset), ("GPU at full precision", "cuda", full), ("CPU", "cpu", full)]
    outputs: list[dict[str, np.ndarray]] = []
    for label, device, settings in steps:
        if device == "cuda" and settings is full and preset.precision == "fp32":
            outputs.append(outputs[0])  # the preset already runs at full precision
            continue
        try:
            outputs.append(run(device, settings))
        except Exception as exc:
            result.detail = f"{label} run failed: {type(exc).__name__}: {exc}"
            return result
    as_used, gpu_full, cpu = outputs

    # Errors are measured against the input, not against each stem: a stem that is close
    # to silent on the test signal would make any tiny difference look enormous.
    result.difference_db = max(difference_db(gpu_full[s], cpu[s], mix) for s in cpu)
    result.half_precision_db = max(difference_db(as_used[s], cpu[s], mix) for s in cpu)
    if result.difference_db > MODEL_PASS_DB:
        result.detail = f"GPU and CPU differ by more than {MODEL_PASS_DB:g} dB"
    elif result.half_precision_db > HALF_PRECISION_PASS_DB:
        result.detail = f"half precision is off by more than {HALF_PRECISION_PASS_DB:g} dB"
    else:
        result.ok = True
    return result


def run_selftest(
    model_ids: list[str] | None = None,
    *,
    seconds: float = 6.0,
    with_models: bool = True,
    on_step: Callable[[str], None] | None = None,
) -> SelfTestReport:
    """Run the op checks, then one short separation per chosen model on both devices."""
    from openstems.doctor import no_gpu_problem, torch_backend

    report = SelfTestReport()
    try:
        import torch
    except ImportError as exc:
        report.problems.append(f"PyTorch import failed: {exc}")
        return report

    report.torch = torch.__version__
    report.gpu_backend, report.gpu_backend_version = torch_backend(torch.version)
    report.gpu_available = bool(torch.cuda.is_available())
    if not report.gpu_available:
        report.problems.append(no_gpu_problem(report.gpu_backend))
        return report
    report.gpu_name = torch.cuda.get_device_name(0)

    if on_step:
        on_step("operations")
    report.ops = run_op_checks()
    if not with_models:
        return report

    from openstems.runtime import build_runtime

    runtime = build_runtime()
    if model_ids:
        specs = [runtime.catalog.get(model_id) for model_id in model_ids]
    else:
        specs = default_models(runtime.catalog, runtime.store)
        if not specs:
            report.problems.append(
                "No model is installed, so only the operations were checked. "
                "Download one (openstems models pull) and run the self-test again."
            )
    for spec in specs:
        if on_step:
            on_step(spec.id)
        report.models.append(check_model(spec, runtime.store, seconds))
    return report
