"""GPU backend detection, the CPU switch and the self-test's comparisons (all on the CPU)."""

from __future__ import annotations

import json
from types import SimpleNamespace

import numpy as np
import pytest
from typer.testing import CliRunner

from openstems import selftest
from openstems.cli import app
from openstems.doctor import DoctorReport, no_gpu_problem, torch_backend
from openstems.engines import torch_common
from openstems.runtime import build_runtime
from openstems.settings import load_settings, update_settings


def test_backend_comes_from_how_torch_was_built() -> None:
    assert torch_backend(SimpleNamespace(cuda="13.0", hip=None)) == ("cuda", "13.0")
    assert torch_backend(SimpleNamespace(cuda=None, hip="7.2.53211-158bd99533")) == (
        "rocm",
        "7.2.53211",
    )
    assert torch_backend(SimpleNamespace(cuda=None)) == (None, None)


def test_report_names_the_backend() -> None:
    def report(backend: str | None, version: str | None) -> DoctorReport:
        return DoctorReport(
            python="3.12",
            torch="2.9.1",
            cuda_available=True,
            cuda_version=None,
            gpu_name="Radeon RX 7900 XTX",
            vram_gb=24.0,
            ffmpeg="PyAV",
            ffmpeg_decode_ok=True,
            gpu_backend=backend,
            gpu_backend_version=version,
        )

    amd = report("rocm", "7.2.53211")
    assert amd.ok
    assert ("GPU backend", "ROCm 7.2.53211") in amd.lines()
    assert ("GPU backend", "CUDA 13.0") in report("cuda", "13.0").lines()
    assert ("GPU backend", "none (CPU build)") in report(None, None).lines()


def test_missing_gpu_message_fits_the_build() -> None:
    assert "Radeon" in no_gpu_problem("rocm")
    assert "RX 7900 XTX" in no_gpu_problem("rocm")
    assert "NVIDIA" in no_gpu_problem("cuda")
    assert "CPU" in no_gpu_problem(None)


def test_device_env_forces_the_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(torch_common.torch.cuda, "is_available", lambda: True)
    assert torch_common.pick_device().type == "cuda"
    monkeypatch.setenv("OPENSTEMS_DEVICE", "cpu")
    assert torch_common.pick_device().type == "cpu"


def test_use_gpu_setting_forces_the_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(torch_common.torch.cuda, "is_available", lambda: True)
    assert load_settings().use_gpu
    update_settings({"use_gpu": False})
    assert torch_common.pick_device().type == "cpu"
    monkeypatch.setenv("OPENSTEMS_DEVICE", "cuda")  # the environment wins over the file
    assert torch_common.pick_device().type == "cuda"


def test_switching_the_gpu_off_drops_warm_models() -> None:
    runtime = build_runtime()
    cleared: list[bool] = []
    runtime.pipeline.host.clear = lambda: cleared.append(True)  # type: ignore[method-assign]
    runtime.reload()
    assert not cleared
    update_settings({"use_gpu": False})
    runtime.reload()
    assert cleared == [True]
    assert not runtime.settings.use_gpu


def test_relative_error() -> None:
    ref = np.array([0.0, 2.0, -4.0], dtype=np.float32)
    assert selftest.relative_error(ref, ref) == 0.0
    assert selftest.relative_error(ref + 0.004, ref) == pytest.approx(0.001, rel=1e-3)
    assert selftest.relative_error(np.array([np.nan, 2.0, -4.0], dtype=np.float32), ref) == float(
        "inf"
    )
    assert selftest.relative_error(ref[:2], ref) == float("inf")


def test_difference_db_is_measured_against_the_scale() -> None:
    mix = np.ones((2, 1000), dtype=np.float32)
    quiet = np.full((2, 1000), 1e-4, dtype=np.float32)  # a stem that is close to silent
    off = quiet * 2
    assert selftest.difference_db(off, quiet) == pytest.approx(0.0, abs=1e-3)  # looks terrible
    assert selftest.difference_db(off, quiet, mix) == pytest.approx(-80.0, abs=1e-3)
    assert selftest.difference_db(quiet, quiet, mix) == float("-inf")
    assert selftest.difference_db(np.full_like(quiet, np.inf), quiet, mix) == float("inf")


def test_op_cases_run_on_the_cpu() -> None:
    import torch

    names = []
    with torch.inference_mode():
        for name, fn, tolerance in selftest._op_cases():
            first, second = fn("cpu").numpy(), fn("cpu").numpy()
            assert selftest.relative_error(second, first) == 0.0, name  # inputs are seeded
            assert tolerance > 0
            names.append(name)
    assert {"stft", "istft", "conv2d", "attention"} <= set(names)


def test_selftest_without_a_gpu_reports_it(monkeypatch: pytest.MonkeyPatch) -> None:
    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    report = selftest.run_selftest()
    assert not report.ok
    assert not report.ops
    assert report.problems

    result = CliRunner().invoke(app, ["selftest", "--json"])
    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert payload["ok"] is False
    assert payload["gpu_available"] is False


def test_default_models_take_one_per_architecture() -> None:
    specs = [
        SimpleNamespace(id="a1", architecture="a"),
        SimpleNamespace(id="a2", architecture="a"),
        SimpleNamespace(id="b1", architecture="b"),
        SimpleNamespace(id="c1", architecture="c"),
    ]
    store = SimpleNamespace(is_installed=lambda spec: spec.id != "a1" and spec.id != "c1")
    assert [s.id for s in selftest.default_models(specs, store)] == ["a2", "b1"]


def test_report_is_valid_json_when_numbers_are_infinite() -> None:
    report = selftest.SelfTestReport(gpu_available=True)
    report.ops.append(selftest.OpResult("stft", False, float("inf")))
    report.models.append(selftest.ModelResult("m", True, float("-inf"), -72.5))
    data = json.loads(json.dumps(report.to_dict(), allow_nan=False))
    assert data["ops"][0]["error"] is None
    assert data["models"][0]["difference_db"] == -300.0
    assert data["models"][0]["half_precision_db"] == -72.5
