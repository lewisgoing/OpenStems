"""The Mac build (Apple Silicon, MPS), checked without a Mac: the device choice, memory
handling, the STFT safety net, the doctor and the folders, with the platform and
``torch.backends.mps`` stood in for. Nothing here touches a GPU."""

from __future__ import annotations

import importlib
import logging
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch
from typer.testing import CliRunner

import openstems
from openstems import doctor, procutil, selftest, settings
from openstems.cli import app
from openstems.engines import device, stft_fallback, torch_common
from openstems.engines.runner import demix, use_half_precision
from openstems.runtime import build_runtime

from .conftest import fake_spec

MPS_OOM = (
    "MPS backend out of memory (MPS allocated: 17.00 GB, other allocations: 1.02 GB, "
    "max allowed: 18.13 GB). Tried to allocate 256.00 MB on private pool. "
    "Use PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 to disable upper limit for memory allocations "
    "(may cause system failure)."
)


@pytest.fixture(autouse=True)
def real_stft() -> Iterator[None]:
    """Whatever a test does to ``torch.stft``, the next test gets the real one."""
    before = (torch.stft, torch.functional.stft, torch.istft)
    stft_fallback.uninstall()
    yield
    stft_fallback.uninstall()
    assert (torch.stft, torch.functional.stft, torch.istft) == before


def pretend_gpus(monkeypatch: pytest.MonkeyPatch, *, cuda: bool, mps: bool) -> None:
    monkeypatch.setattr(torch.cuda, "is_available", lambda: cuda)
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: mps)


@pytest.fixture
def mps_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Stand-ins for the ``torch.mps`` calls, which raise on a build without MPS."""
    calls: list[str] = []
    monkeypatch.setattr(torch.mps, "empty_cache", lambda: calls.append("empty_cache"))
    monkeypatch.setattr(torch.mps, "synchronize", lambda: calls.append("synchronize"))
    monkeypatch.setattr(torch.mps, "driver_allocated_memory", lambda: 3 * 1024**3)
    return calls


# -- device ---------------------------------------------------------------------------


def test_the_apple_gpu_is_picked_when_there_is_no_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    pretend_gpus(monkeypatch, cuda=False, mps=True)
    assert torch_common.pick_device() == torch.device("mps")
    assert device.gpu_device_name() == "mps"
    monkeypatch.setenv("OPENSTEMS_DEVICE", "cpu")
    assert torch_common.pick_device().type == "cpu"


def test_the_use_gpu_setting_keeps_a_mac_on_the_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    pretend_gpus(monkeypatch, cuda=False, mps=True)
    settings.update_settings({"use_gpu": False})
    assert torch_common.pick_device().type == "cpu"


def test_cuda_wins_and_no_gpu_means_the_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    pretend_gpus(monkeypatch, cuda=True, mps=True)
    assert torch_common.pick_device().type == "cuda"
    assert device.gpu_device_name() == "cuda"
    pretend_gpus(monkeypatch, cuda=False, mps=False)
    assert torch_common.pick_device().type == "cpu"
    assert device.gpu_device_name() is None


def test_a_card_this_build_cannot_run_does_not_fall_through_to_mps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pretend_gpus(monkeypatch, cuda=True, mps=True)
    monkeypatch.setattr(torch_common, "card_supported", lambda: False)
    assert torch_common.pick_device().type == "cpu"


def test_a_build_without_mps_says_so_instead_of_raising(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> bool:
        raise RuntimeError("no such backend")

    monkeypatch.setattr(torch.backends.mps, "is_available", broken)
    assert device.mps_available() is False


def test_memory_calls_go_to_the_right_backend(
    monkeypatch: pytest.MonkeyPatch, mps_calls: list[str]
) -> None:
    cuda: list[str] = []
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: cuda.append("empty_cache"))
    monkeypatch.setattr(torch.cuda, "synchronize", lambda: cuda.append("synchronize"))
    for name in ("cpu", "mps", torch.device("cuda:0")):
        device.empty_cache(name)
        device.synchronize(name)
    assert mps_calls == ["empty_cache", "synchronize"]
    assert cuda == ["empty_cache", "synchronize"]
    assert device.used_memory_bytes("mps") == 3 * 1024**3
    assert device.used_memory_bytes("cpu") == 0
    assert device.is_gpu("mps") and device.is_gpu("cuda:0") and not device.is_gpu("cpu")


def test_the_apple_gpu_never_runs_at_half_precision() -> None:
    assert use_half_precision("mps") is False
    assert use_half_precision("cpu") is False


def test_weights_on_the_apple_gpu_count_against_the_budget(mps_calls: list[str]) -> None:
    module = torch.nn.Linear(10, 10)
    spec = fake_spec("m", ("vocals",))
    on_gpu = torch_common.TorchLoadedModel(spec, module, torch.device("mps"))
    assert on_gpu.vram_bytes == 110 * 4
    assert torch_common.TorchLoadedModel(spec, module, torch.device("cpu")).vram_bytes == 0
    on_gpu.unload()
    assert mps_calls == ["empty_cache"]


# -- out of memory --------------------------------------------------------------------


def test_out_of_memory_is_recognised_in_each_backends_words() -> None:
    assert device.is_oom(torch.OutOfMemoryError("CUDA out of memory"))
    assert device.is_oom(RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB"))
    assert device.is_oom(RuntimeError(MPS_OOM), "mps")
    assert device.is_oom(RuntimeError(MPS_OOM))  # the words are enough, whatever the device
    assert device.is_oom(RuntimeError("Invalid buffer size: 12.50 GB"), "mps")
    assert not device.is_oom(RuntimeError("Invalid buffer size: 12.50 GB"), "cuda:0")
    assert not device.is_oom(RuntimeError("shape mismatch"), "mps")
    assert not device.is_oom(ValueError("out of memory"), "mps")


def test_an_mps_out_of_memory_error_halves_the_batch() -> None:
    sizes: list[int] = []

    def model(x: torch.Tensor) -> torch.Tensor:
        sizes.append(x.shape[0])
        if x.shape[0] > 2:
            raise RuntimeError(MPS_OOM)
        return x

    mix = torch.ones((2, 20000))
    out = demix(model, mix, num_stems=1, chunk_size=1000, num_overlap=2, batch_size=8)
    torch.testing.assert_close(out[0], mix, atol=1e-5, rtol=1e-4)
    assert sizes[:3] == [8, 4, 2] and max(sizes[2:]) == 2


# -- the STFT safety net --------------------------------------------------------------


def wave() -> torch.Tensor:
    return torch.randn(2, 8192, generator=torch.Generator().manual_seed(1))


def test_the_wrapper_is_exact_and_only_steps_in_where_it_applies() -> None:
    seen: list[str] = []

    def original(x: torch.Tensor, *args: object, **kwargs: object) -> torch.Tensor:
        seen.append("called")
        return torch.stft(x, *args, **kwargs)  # type: ignore[arg-type]

    window = torch.hann_window(1024)
    expected = torch.stft(wave(), 1024, 256, window=window, return_complex=True)
    for applies in (lambda t: True, lambda t: False):
        wrapped = stft_fallback.on_cpu(original, applies)
        by_keyword = wrapped(wave(), 1024, 256, window=window, return_complex=True)
        by_position = wrapped(wave(), 1024, 256, 1024, window, return_complex=True)
        assert torch.equal(by_keyword, expected)
        assert torch.equal(by_position, expected)
    assert len(seen) == 4
    assert stft_fallback.on_cpu(torch.istft).__wrapped__ is torch.istft  # type: ignore[attr-defined]


def test_the_patch_gives_the_same_numbers_and_restores_cleanly() -> None:
    real = (torch.stft, torch.functional.stft, torch.istft)
    window = torch.hann_window(1024)
    spec = torch.stft(wave(), 1024, 256, window=window, return_complex=True)
    back = torch.istft(spec, 1024, 256, window=window, length=8192)

    stft_fallback.install(applies=lambda t: True)  # as if every tensor were on the Apple GPU
    assert stft_fallback.installed()
    assert torch.stft is not real[0] and torch.istft is not real[2]
    assert torch.functional.stft is torch.stft
    patched = torch.stft(wave(), 1024, 256, window=window, return_complex=True)
    assert torch.equal(patched, spec)
    assert torch.equal(wave().stft(1024, 256, window=window, return_complex=True), spec)
    assert torch.equal(torch.istft(patched, 1024, 256, window=window, length=8192), back)
    assert torch.equal(patched.istft(1024, 256, window=window, length=8192), back)
    stft_fallback.check_stft("cpu")  # the engine's own round trip passes through the patch

    stft_fallback.install()  # a second call changes nothing
    assert torch.stft.__wrapped__ is real[0]  # type: ignore[attr-defined]
    stft_fallback.uninstall()
    assert (torch.stft, torch.functional.stft, torch.istft) == real
    assert not stft_fallback.installed()
    stft_fallback.uninstall()  # and so does a second uninstall
    assert torch.stft is real[0]


def test_the_patch_leaves_tensors_off_the_apple_gpu_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    window = torch.hann_window(1024)
    expected = torch.stft(wave(), 1024, 256, window=window, return_complex=True)
    stft_fallback.install()  # the real rule: only tensors on "mps"
    moved: list[bool] = []
    real_cpu = torch.Tensor.cpu
    monkeypatch.setattr(
        torch.Tensor, "cpu", lambda self, *a, **k: moved.append(True) or real_cpu(self, *a, **k)
    )
    got = torch.stft(wave(), 1024, 256, window=window, return_complex=True)
    assert torch.equal(got, expected)
    assert not moved  # a CPU tensor went straight to the real function


def test_a_good_stft_is_left_alone(caplog: pytest.LogCaptureFixture) -> None:
    checked: list[str] = []
    with caplog.at_level(logging.WARNING):
        assert stft_fallback.ensure_stft("mps", check=lambda d: checked.append(str(d))) is None
        assert stft_fallback.ensure_stft("mps", check=lambda d: checked.append(str(d))) is None
    assert checked == ["mps"]  # once per process
    assert not stft_fallback.installed()
    assert stft_fallback.fallback_note() is None
    assert not caplog.records


def test_a_bad_stft_moves_to_the_cpu_and_says_so(caplog: pytest.LogCaptureFixture) -> None:
    checked: list[str] = []

    def wrong(d: object) -> None:
        checked.append(str(d))
        raise RuntimeError("the GPU STFT does not match the CPU STFT")

    with caplog.at_level(logging.WARNING):
        note = stft_fallback.ensure_stft(torch.device("mps"), check=wrong)
        again = stft_fallback.ensure_stft("mps", check=wrong)
    assert checked == ["mps"]
    assert stft_fallback.installed()
    assert note == again == stft_fallback.fallback_note()
    assert note is not None and "runs on the CPU" in note and "does not match" in note
    assert len(caplog.records) == 1 and "on the CPU" in caplog.records[0].getMessage()


def test_only_the_apple_gpu_is_checked() -> None:
    def never(d: object) -> None:
        raise AssertionError("the check must not run")

    assert stft_fallback.ensure_stft("cpu", check=never) is None
    assert stft_fallback.ensure_stft("cuda:0", check=never) is None
    assert not stft_fallback.installed()


def test_the_stft_check_takes_a_device_and_catches_a_wrong_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stft_fallback.check_stft("cpu")
    doctor.check_gpu_ops(torch, "cpu")
    real = torch.stft
    calls: list[int] = []

    def second_is_wrong(*args: object, **kwargs: object) -> torch.Tensor:
        calls.append(1)  # the check asks the CPU first, then the device
        return real(*args, **kwargs) * (1.5 if len(calls) == 2 else 1.0)  # type: ignore[arg-type]

    with monkeypatch.context() as patch:
        patch.setattr(torch, "stft", second_is_wrong)
        with pytest.raises(RuntimeError, match="does not match"):
            stft_fallback.check_stft("cpu")


def test_loading_a_model_checks_the_stft_first(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(torch_common, "ensure_stft", lambda d: seen.append(str(d)))
    monkeypatch.setattr(torch_common, "pick_device", lambda: torch.device("cpu"))
    module = torch.nn.Linear(4, 4)
    spec = fake_spec("m", ("vocals",))
    loaded = torch_common.finish_load(spec, module, module.state_dict(), ("vocals",))
    assert seen == ["cpu"] and loaded.device.type == "cpu"


# -- doctor ---------------------------------------------------------------------------


@pytest.fixture
def mac(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """A 16 GB M2 Pro on macOS 14.5 with the Mac build of PyTorch, as far as the doctor
    can tell. The GPU checks themselves are stood in for."""
    pretend_gpus(monkeypatch, cuda=False, mps=True)
    monkeypatch.setattr(torch.backends.mps, "is_built", lambda: True)
    monkeypatch.setattr(torch.version, "cuda", None)
    monkeypatch.setattr(doctor.platform, "mac_ver", lambda: ("14.5", ("", "", ""), "arm64"))
    monkeypatch.setattr(doctor.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(doctor, "mac_gpu_name", lambda: "Apple M2 Pro")
    monkeypatch.setattr(doctor, "physical_memory_bytes", lambda: 16 * 1024**3)
    monkeypatch.setattr(doctor, "check_gpu_ops", lambda torch, device="cuda": None)
    monkeypatch.setattr(stft_fallback, "check_stft", lambda d: None)
    return monkeypatch


def test_the_backend_is_mps_on_a_mac_build(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor.platform, "mac_ver", lambda: ("15.1", ("", "", ""), "arm64"))
    plain = SimpleNamespace(cuda=None)
    assert doctor.torch_backend(plain, mps_built=True) == ("mps", "macOS 15.1")
    assert doctor.torch_backend(plain, mps_built=False) == (None, None)
    assert doctor.torch_backend(plain) == (None, None)
    # A build cannot be both, but CUDA and ROCm answer first if it ever claims to be.
    assert doctor.torch_backend(SimpleNamespace(cuda="13.0"), mps_built=True) == ("cuda", "13.0")
    assert doctor.BACKEND_NAMES["mps"] == "MPS"
    assert doctor.mps_built(torch) is torch.backends.mps.is_built()
    assert doctor.mps_built(object()) is False


def test_the_doctor_on_a_mac(mac: pytest.MonkeyPatch) -> None:
    report = doctor.run_doctor()
    assert report.gpu_backend == "mps"
    assert report.gpu_backend_version == "macOS 14.5"
    assert report.cuda_available  # the old name: it means "a GPU works"
    assert report.cuda_version is None
    assert report.gpu_name == "Apple M2 Pro"
    assert report.vram_gb == 16.0
    assert report.ok and not report.problems and not report.notes
    lines = report.lines()
    assert len(lines) == 9
    assert ("GPU backend", "MPS macOS 14.5") in lines
    assert ("GPU available", "yes") in lines
    assert ("Memory (shared)", "16.0 GB") in lines
    assert ("Memory for one model", "10.5 GB") in lines

    result = CliRunner().invoke(app, ["doctor"])
    assert result.exit_code == 0
    assert "Apple M2 Pro" in result.output


def test_the_doctor_reports_an_stft_that_moved_to_the_cpu(mac: pytest.MonkeyPatch) -> None:
    def wrong(d: object) -> None:
        raise RuntimeError("the GPU STFT does not match the CPU STFT")

    mac.setattr(stft_fallback, "check_stft", wrong)
    report = doctor.run_doctor()
    assert report.ok and not report.problems  # the GPU still does the rest
    assert len(report.notes) == 1 and "runs on the CPU" in report.notes[0]
    assert stft_fallback.installed()

    result = CliRunner().invoke(app, ["doctor"])
    assert result.exit_code == 0
    assert "note:" in result.output


def test_the_doctor_reports_an_apple_gpu_that_fails(mac: pytest.MonkeyPatch) -> None:
    def broken(torch: object, device: str = "cuda") -> None:
        raise RuntimeError(f"wrong result from a GPU op on {device}")

    mac.setattr(doctor, "check_gpu_ops", broken)
    report = doctor.run_doctor()
    assert not report.cuda_available and not report.ok
    assert "Apple GPU" in report.problems[0] and "on mps" in report.problems[0]
    assert report.gpu_name == "Apple M2 Pro"


def test_the_doctor_says_why_a_mac_has_no_gpu(mac: pytest.MonkeyPatch) -> None:
    pretend_gpus(mac, cuda=False, mps=False)
    report = doctor.run_doctor()
    assert report.gpu_backend == "mps" and not report.cuda_available and not report.ok
    assert report.gpu_name is None and report.vram_gb is None
    assert "not available" in report.problems[0]

    mac.setattr(doctor.platform, "mac_ver", lambda: ("13.6.1", ("", "", ""), "arm64"))
    old = doctor.run_doctor().problems[0]
    assert "macOS 13.6.1" in old and "macOS 14 or later" in old


def test_mac_problems_name_the_cause() -> None:
    assert "Intel" in doctor.mac_problem("x86_64", "14.5")
    assert "Apple Silicon" in doctor.mac_problem("x86_64", "12.0")  # Intel is the first cause
    assert "macOS 12.7" in doctor.mac_problem("arm64", "12.7")
    assert "update macOS" in doctor.mac_problem("arm64", "13.0")
    for machine, release in (("arm64", "14.0"), ("arm64", "26.1"), ("", ""), ("arm64", "?")):
        text = doctor.mac_problem(machine, release)
        assert "not available" in text and "CPU" in text


def test_the_missing_gpu_text_fits_a_mac(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor.platform, "machine", lambda: "arm64")
    monkeypatch.setattr(doctor.platform, "mac_ver", lambda: ("14.5", ("", "", ""), "arm64"))
    assert "Apple GPU" in doctor.no_gpu_problem("mps")
    assert "NVIDIA" in doctor.no_gpu_problem("cuda")  # unchanged
    assert "Radeon" in doctor.no_gpu_problem("rocm")
    monkeypatch.setattr(doctor.sys, "platform", "win32")
    assert doctor.no_gpu_problem(None).startswith("This PyTorch build has no GPU support")
    monkeypatch.setattr(doctor.sys, "platform", "darwin")
    assert "Apple GPU" in doctor.no_gpu_problem(None)


def test_the_gpu_name_is_the_chip_with_a_safe_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(doctor.sys, "platform", "darwin")
    monkeypatch.setattr(doctor, "_sysctl", lambda name: "Apple M3 Max\n")
    assert doctor.mac_gpu_name() == "Apple M3 Max"
    monkeypatch.setattr(doctor, "_sysctl", lambda name: "")
    monkeypatch.setattr(doctor.platform, "processor", lambda: "arm")
    assert doctor.mac_gpu_name() == "Apple GPU"
    monkeypatch.setattr(doctor.platform, "processor", lambda: "Apple M1")
    assert doctor.mac_gpu_name() == "Apple M1"

    def broken() -> str:
        raise OSError("no such thing")

    monkeypatch.setattr(doctor.platform, "processor", broken)
    assert doctor.mac_gpu_name() == "Apple GPU"


def test_sysctl_that_cannot_run_gives_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(*args: object, **kwargs: object) -> None:
        raise FileNotFoundError("sysctl")

    monkeypatch.setattr(doctor.subprocess, "run", missing)
    assert doctor._sysctl("machdep.cpu.brand_string") == ""
    monkeypatch.setattr(
        doctor.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1, stdout="x")
    )
    assert doctor._sysctl("machdep.cpu.brand_string") == ""
    monkeypatch.setattr(
        doctor.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stdout="M2\n")
    )
    assert doctor._sysctl("machdep.cpu.brand_string") == "M2"


# -- self-test ------------------------------------------------------------------------


def test_the_op_checks_run_on_whatever_device_they_are_given() -> None:
    results = selftest.run_op_checks("cpu")
    assert len(results) == len(selftest._op_cases())
    assert all(r.ok and r.error == 0.0 for r in results)


def test_the_self_test_runs_on_the_apple_gpu(mac: pytest.MonkeyPatch) -> None:
    devices: list[str] = []

    def ops(name: str = "cuda") -> list[selftest.OpResult]:
        devices.append(name)
        return [selftest.OpResult("stft", True, 0.0), selftest.OpResult("conv1d", True, 0.0)]

    mac.setattr(selftest, "run_op_checks", ops)
    report = selftest.run_selftest(with_models=False)
    assert devices == ["mps"]
    assert report.gpu_available and report.ok
    assert report.gpu_backend == "mps" and report.gpu_name == "Apple M2 Pro"
    assert report.to_dict()["notes"] == []


def test_the_self_test_shows_the_stft_as_the_app_runs_it(mac: pytest.MonkeyPatch) -> None:
    def wrong(d: object) -> None:
        raise RuntimeError("the GPU STFT does not match the CPU STFT")

    def ops(name: str = "cuda") -> list[selftest.OpResult]:
        fixed = stft_fallback.installed()
        return [
            selftest.OpResult("stft", fixed, 0.0 if fixed else 0.5),
            selftest.OpResult("conv1d", True, 0.0),
        ]

    mac.setattr(stft_fallback, "check_stft", wrong)
    mac.setattr(selftest, "run_op_checks", ops)
    report = selftest.run_selftest(with_models=False)
    assert report.ok
    assert [(op.name, op.detail) for op in report.ops] == [("stft", "on the CPU"), ("conv1d", "")]
    assert len(report.notes) == 1


# -- folders --------------------------------------------------------------------------


@pytest.fixture
def mac_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A Mac user's home in a temp folder, with no folder chosen through the environment."""
    for name in ("CONFIG", "MODELS", "OUTPUT", "CACHE"):
        monkeypatch.delenv(f"OPENSTEMS_{name}_DIR", raising=False)
    monkeypatch.setattr(settings.sys, "platform", "darwin")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    # Left over from Windows on purpose: a Mac must not look at them.
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    return tmp_path


def test_folders_on_a_mac(mac_home: Path) -> None:
    library = mac_home / "Library"
    support = library / "Application Support" / "OpenStems"
    loaded = settings.load_settings()
    assert settings.config_dir() == support
    assert settings.settings_file() == support / "settings.json"
    assert loaded.recipes_path == support / "recipes"
    assert loaded.models_path == support / "models"
    assert loaded.cache_path == library / "Caches" / "OpenStems"
    assert loaded.logs_path == library / "Logs" / "OpenStems"
    assert loaded.output_path == mac_home / "Music" / "OpenStems"
    assert not (mac_home / "Roaming").exists() and not (mac_home / "Local").exists()

    settings.update_settings({"default_quality": "best"})
    assert (support / "settings.json").is_file()
    assert settings.load_settings().default_quality == "best"


def test_environment_overrides_still_win_on_a_mac(
    mac_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENSTEMS_CONFIG_DIR", str(mac_home / "portable"))
    monkeypatch.setenv("OPENSTEMS_MODELS_DIR", str(mac_home / "big" / "models"))
    assert settings.config_dir() == mac_home / "portable"
    assert settings.load_settings().models_path == mac_home / "big" / "models"


def test_a_mac_has_no_old_name_to_carry_over(mac_home: Path) -> None:
    old = mac_home / "Roaming" / "lew-stems" / "settings.json"
    old.parent.mkdir(parents=True)
    old.write_text('{"default_quality": "best"}', encoding="utf-8")
    (mac_home / "Music" / "lew-stems" / "Song").mkdir(parents=True)
    (mac_home / "Music" / "lew-stems" / "Song" / "a.wav").write_text("x", encoding="utf-8")
    loaded = settings.load_settings()
    assert loaded.default_quality == "balanced"
    assert loaded.output_path == mac_home / "Music" / "OpenStems"
    assert not settings.settings_file().exists()


def test_diagnostics_and_the_self_test_report_go_to_the_mac_logs_folder(mac_home: Path) -> None:
    from openstems.diagnostics import export_diagnostics

    logs = mac_home / "Library" / "Logs" / "OpenStems"
    service = SimpleNamespace(
        runtime=SimpleNamespace(settings=settings.load_settings()),
        models=lambda: {"models": []},
        system=lambda: {},
        recipes=lambda: [],
        jobs=SimpleNamespace(list=lambda: []),
    )
    path = export_diagnostics(service)
    assert path.parent == logs and path.is_file()


def test_the_model_budget_is_capped_by_a_macs_memory(
    mac_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(procutil, "physical_memory_bytes", lambda: 8 * 1024**3)
    loaded = settings.load_settings()
    assert loaded.vram_budget_gb == 12.0  # the setting itself is not rewritten
    assert loaded.vram_budget_bytes == 4 * 1024**3
    assert build_runtime().pipeline.host.budget == 4 * 1024**3
    monkeypatch.setattr(procutil, "physical_memory_bytes", lambda: 64 * 1024**3)
    assert settings.load_settings().vram_budget_bytes == 12 * 1024**3
    monkeypatch.setattr(procutil, "physical_memory_bytes", lambda: None)
    assert settings.load_settings().vram_budget_bytes == 12 * 1024**3


def test_the_model_budget_is_the_setting_everywhere_else(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "_is_mac", lambda: False)
    monkeypatch.setattr(procutil, "physical_memory_bytes", lambda: 8 * 1024**3)
    assert settings.load_settings().vram_budget_bytes == 12 * 1024**3
    assert build_runtime().pipeline.host.budget == 12 * 1024**3


# -- process --------------------------------------------------------------------------


def test_the_machines_memory_is_read_where_the_system_offers_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sizes = {"SC_PHYS_PAGES": 1_048_576, "SC_PAGE_SIZE": 16384}
    monkeypatch.setattr(procutil.os, "sysconf", lambda name: sizes[name], raising=False)
    assert procutil.physical_memory_bytes() == 16 * 1024**3

    def unknown(name: str) -> int:
        raise ValueError("unrecognized configuration name")

    monkeypatch.setattr(procutil.os, "sysconf", unknown, raising=False)
    assert procutil.physical_memory_bytes() is None
    monkeypatch.delattr(procutil.os, "sysconf")  # Windows has no such call: it has its own
    monkeypatch.setattr(procutil, "_windows_memory_bytes", lambda: 32 * 1024**3)
    monkeypatch.setattr(procutil.os, "name", "nt")
    assert procutil.physical_memory_bytes() == 32 * 1024**3
    monkeypatch.setattr(procutil.os, "name", "posix")
    assert procutil.physical_memory_bytes() is None


def test_this_process_is_alive_and_a_made_up_one_is_not() -> None:
    assert procutil.process_alive(os.getpid())
    assert not procutil.process_alive(2**22 + 12345)


def test_mps_fallback_is_switched_on_before_torch_on_a_mac_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    name = "PYTORCH_ENABLE_MPS_FALLBACK"
    monkeypatch.setenv(name, "x")
    monkeypatch.delenv(name)
    try:
        importlib.reload(openstems)
        if sys.platform != "darwin":
            assert name not in os.environ  # Windows is left exactly as it was
        monkeypatch.setattr(sys, "platform", "darwin")
        importlib.reload(openstems)
        assert os.environ[name] == "1"
        monkeypatch.setenv(name, "0")  # a choice made by hand is kept
        importlib.reload(openstems)
        assert os.environ[name] == "0"
    finally:
        monkeypatch.undo()
        importlib.reload(openstems)
