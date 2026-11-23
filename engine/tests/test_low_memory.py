"""Machines with little memory: what a model needs, what the machine has for it, whether it
fits, and what happens when it does not. Everything is stood in for: no GPU is touched and
no model is run."""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import torch
from fastapi.testclient import TestClient

from openstems import doctor, procutil, settings
from openstems.api import service as service_module
from openstems.api.app import create_app
from openstems.api.service import Service
from openstems.catalog.catalog import load_catalog, parse_catalog
from openstems.domain.errors import DomainError, OutOfMemory
from openstems.domain.memory import (
    CPU_NOTE,
    FITS,
    GB,
    NO,
    TIGHT,
    UNKNOWN,
    fit,
    half_precision_bytes,
    memory_is_estimated,
    plan_memory,
    recommended_ids,
    run_budget_bytes,
    run_memory_bytes,
)
from openstems.domain.recipe import OutputStem, PassSpec, Recipe
from openstems.engines import device, fake, host, torch_common
from openstems.engines.fake import FakeEngine, FakeLoadedModel
from openstems.pipeline import run as run_module
from openstems.pipeline.run import Pipeline, read_manifest
from openstems.runtime import build_runtime
from openstems.worker.process import (
    IDLE_UNLOAD_SECONDS,
    SMALL_IDLE_UNLOAD_SECONDS,
    idle_unload_seconds,
)

from .conftest import RATE, fake_spec, tone

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
MPS_OOM = "MPS backend out of memory (MPS allocated: 7.10 GB, other allocations: 1.02 GB)"
MPS_BUFFER = "Invalid buffer size: 9.54 GB"  # one buffer larger than Metal allows

MAC_8 = plan_memory("mps", 8 * GB, full_precision=True)
MAC_16 = plan_memory("mps", 16 * GB, full_precision=True)
CARD_4 = plan_memory("cuda", 4 * GB, full_precision=False)
CARD_16 = plan_memory("cuda", 16 * GB, full_precision=False)
OLD_CARD_6 = plan_memory("cuda", 6 * GB, full_precision=True)


@pytest.fixture(autouse=True)
def fresh_fake() -> Iterator[None]:
    fake._once.clear()
    yield
    fake._once.clear()


def drum_kit() -> Recipe:
    return Recipe(
        id="drum-kit",
        name="Drum kit",
        version=1,
        passes=(PassSpec("sw", ("six",)), PassSpec("kit", ("kit",), input="sw.drums")),
        outputs=(OutputStem("kick", "kit.kick"),),
    )


def one_model(model_id: str = "vox") -> Recipe:
    return Recipe(
        id=f"only-{model_id}",
        name="One model",
        version=1,
        passes=(PassSpec("a", (model_id,)),),
        outputs=(OutputStem("vocals", "a.vocals"),),
    )


# -- the numbers ----------------------------------------------------------------------


def test_the_fit_rule() -> None:
    budget = 10 * GB
    assert fit(int(8.5 * GB), budget) == FITS
    assert fit(int(8.5 * GB) + 1, budget) == TIGHT  # less than 15 percent to spare
    assert fit(budget, budget) == TIGHT
    assert fit(budget + 1, budget) == NO
    assert fit(100 * GB, None) == FITS  # a machine that does not say is not doubted
    assert fit(1, 0) == NO


def test_the_budget_per_kind_of_machine() -> None:
    # A graphics card: all of its memory.
    assert run_budget_bytes("cuda", 6 * GB) == 6 * GB
    # A Mac: 2 GB for the system and the app, then three quarters of the rest.
    assert run_budget_bytes("mps", 8 * GB) == int(4.5 * GB)
    assert run_budget_bytes("mps", 16 * GB) == int(10.5 * GB)
    assert run_budget_bytes("mps", 32 * GB) == int(22.5 * GB)
    assert run_budget_bytes("mps", 1 * GB) == 0
    # The CPU: half of the machine's memory.
    assert run_budget_bytes("cpu", 16 * GB) == 8 * GB
    assert run_budget_bytes("cpu", None) is None and run_budget_bytes("mps", 0) is None
    assert MAC_8.small and CARD_4.small and OLD_CARD_6.small
    assert not MAC_16.small and not CARD_16.small and not UNKNOWN.small


def test_what_a_model_needs() -> None:
    catalog = load_catalog()
    sw = catalog.get("bs-roformer-sw")
    assert sw.memory_gb == 2.32
    assert run_memory_bytes(sw, full_precision=False) == int(2.32 * GB)
    # Full precision: the weights stay as they are, the rest doubles.
    weights = sw.checkpoint.size
    assert run_memory_bytes(sw, full_precision=True) == weights + 2 * (int(2.32 * GB) - weights)
    assert 3.9 * GB < run_memory_bytes(sw, True) < 4.1 * GB
    assert not memory_is_estimated(sw, full_precision=False)
    assert memory_is_estimated(sw, full_precision=True)

    custom = fake_spec("mine", ("vocals",))
    custom = type(custom)(**{**custom.__dict__, "architecture": "mel_band_roformer"})
    assert custom.memory_gb is None and memory_is_estimated(custom, False)
    assert half_precision_bytes(custom) == custom.checkpoint.size + int(1.4 * GB)
    assert run_memory_bytes(custom, True) == custom.checkpoint.size + 2 * int(1.4 * GB)


def test_fits_on_real_machines() -> None:
    catalog = load_catalog()
    sw, leap = catalog.get("bs-roformer-sw"), catalog.get("bs-roformer-leap-xe-vocals")
    mega = catalog.get("bs-roformer-mega-53")
    # The development machine: everything fits, as before.
    assert {CARD_16.fit(m) for m in catalog} == {FITS}
    assert {MAC_16.fit(m) for m in catalog if m is not mega} == {FITS}
    assert MAC_16.fit(mega) == NO
    # An 8 GB Mac runs the six-stem model with little to spare, and not the largest ones.
    assert MAC_8.fit(sw) == TIGHT and MAC_8.fit(leap) == NO
    # A 4 GB card at half precision.
    assert CARD_4.fit(sw) == FITS and CARD_4.fit(leap) == TIGHT and CARD_4.fit(mega) == NO
    # A GTX 1060 runs at full precision, so the same model needs more of its 6 GB.
    assert OLD_CARD_6.fit(sw) == FITS and OLD_CARD_6.fit(leap) == NO
    # A recipe is as large as its largest model.
    largest = MAC_8.largest([sw, leap])
    assert largest is leap and MAC_8.largest([]) is None


def test_the_recommended_set_fits_the_machine() -> None:
    models = list(load_catalog())
    seed = [m.id for m in models if m.seed]
    assert recommended_ids(models, CARD_16) == seed
    assert recommended_ids(models, UNKNOWN) == seed
    small = recommended_ids(models, MAC_8)
    assert small == [
        "bs-roformer-sw",
        "mel-roformer-vocals-becruily",  # stands in for Leap Xe vocals
        "mel-roformer-instrumental-becruily",  # stands in for Leap Xe instrumental
        "bs-roformer-karaoke-anvuew",  # stands in for becruily's karaoke
        "bs-roformer-dereverb-anvuew",
        "mel-roformer-denoise-debleed-gabox",
        "mdx23c-drumsep",
    ]
    by_id = {m.id: m for m in models}
    assert all(MAC_8.fit(by_id[i]) != NO for i in small)
    # With nothing to stand in, a model that does not fit is left out.
    tiny = plan_memory("cuda", 1 * GB, full_precision=False)
    assert recommended_ids(models, tiny) == []


# -- the catalog ----------------------------------------------------------------------


def test_every_catalog_model_carries_its_measured_memory() -> None:
    catalog = load_catalog()
    assert all(m.memory_gb and 0.5 < m.memory_gb < 12 for m in catalog)
    # The generated file matches the figures in the generator.
    script = Path(__file__).resolve().parents[2] / "scripts" / "gen_catalog.py"
    spec = importlib.util.spec_from_file_location("gen_catalog", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["gen_catalog"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop("gen_catalog", None)
    assert {m.id: m.memory_gb for m in catalog} == module.MEMORY_GB


def test_memory_round_trips_through_the_catalog_file() -> None:
    text = """
[models.a]
architecture = "fake"
stems = ["vocals"]
memory_gb = 1.25
[[models.a.files]]
kind = "checkpoint"
name = "a.ckpt"
url = "https://example.com/a"
sha256 = "{sha}"
size = 10

[models.b]
architecture = "fake"
stems = ["vocals"]
[[models.b.files]]
kind = "checkpoint"
name = "b.ckpt"
url = "https://example.com/b"
sha256 = "{sha}"
size = 10
""".replace("{sha}", "ab" * 32)
    models = parse_catalog(text)
    assert models["a"].memory_gb == 1.25 and models["b"].memory_gb is None
    with pytest.raises(DomainError, match="memory_gb"):
        parse_catalog(text.replace("1.25", "-1"))


# -- detection ------------------------------------------------------------------------


def pretend_card(monkeypatch: pytest.MonkeyPatch, gigabytes: float, capability=(12, 0)) -> None:
    monkeypatch.setattr(
        torch.cuda,
        "get_device_properties",
        lambda d=None: SimpleNamespace(total_memory=int(gigabytes * GB)),
    )
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 1)
    monkeypatch.setattr(torch.cuda, "get_device_capability", lambda d=None: capability)


def test_the_budget_on_a_graphics_card_is_its_memory(monkeypatch: pytest.MonkeyPatch) -> None:
    pretend_card(monkeypatch, 6)
    monkeypatch.setattr(device, "physical_memory_bytes", lambda: 64 * GB)
    plan = device.memory_plan("cuda:0")
    assert (plan.kind, plan.budget_bytes, plan.full_precision) == ("cuda", 6 * GB, False)
    assert plan.small and not plan.overridden
    # A GTX 1060: the same memory, but models run at full precision there.
    pretend_card(monkeypatch, 6, capability=(6, 1))
    assert device.memory_plan("cuda:0").full_precision is True


def test_the_budget_on_a_mac_and_on_the_cpu_comes_from_the_machine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(device, "physical_memory_bytes", lambda: 8 * GB)
    mac = device.memory_plan("mps")
    assert (mac.kind, mac.budget_bytes, mac.full_precision) == ("mps", int(4.5 * GB), True)
    cpu = device.memory_plan("cpu")
    assert (cpu.kind, cpu.budget_bytes, cpu.full_precision) == ("cpu", 4 * GB, True)
    monkeypatch.setattr(device, "physical_memory_bytes", lambda: None)
    assert device.memory_plan("cpu").budget_bytes is None


def test_the_override_stands_in_for_the_detected_memory_everywhere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert procutil.memory_override_bytes() is None
    for bad in ("", "soon", "0", "-4", "nan", "inf", "-inf", "1e400", "1e-12", "8GB"):
        monkeypatch.setenv("OPENSTEMS_MEMORY_GB", bad)
        assert procutil.memory_override_bytes() is None
    monkeypatch.setattr(procutil, "physical_memory_bytes", lambda: 32 * GB)
    monkeypatch.setattr(device, "physical_memory_bytes", lambda: 32 * GB)
    assert procutil.machine_memory_bytes() == 32 * GB
    assert device.memory_plan("mps").budget_bytes == int(22.5 * GB)

    monkeypatch.setenv("OPENSTEMS_MEMORY_GB", "8")
    assert procutil.machine_memory_bytes() == 8 * GB
    # A 32 GB Mac acts as an 8 GB one: the budget for a run,
    mac = device.memory_plan("mps")
    assert mac.budget_bytes == int(4.5 * GB) and mac.overridden and mac.small
    # the cap on warm models,
    monkeypatch.setattr(settings, "_is_mac", lambda: True)
    assert settings.load_settings().vram_budget_bytes == 4 * GB
    # and the CPU's share.
    assert device.memory_plan("cpu").budget_bytes == 4 * GB
    # On a PC it stands in for the card's memory.
    pretend_card(monkeypatch, 16)
    card = device.memory_plan("cuda:0")
    assert card.budget_bytes == 8 * GB and card.overridden
    # The FakeEngine has no device: the override alone gives it a budget.
    assert host.memory_plan(fake=True).budget_bytes == 4 * GB
    monkeypatch.delenv("OPENSTEMS_MEMORY_GB")
    assert host.memory_plan(fake=True).budget_bytes is None


@pytest.mark.skipif(sys.platform != "win32", reason="Windows only")
def test_windows_reports_its_memory() -> None:
    memory = procutil.physical_memory_bytes()
    assert memory is not None and 1 * GB < memory < 4096 * GB


def report(**changes: Any) -> doctor.DoctorReport:
    values: dict[str, Any] = dict(
        python="3.12",
        torch="2.14.1",
        cuda_available=True,
        cuda_version="13.0",
        gpu_name="NVIDIA GeForce RTX 5070 Ti",
        vram_gb=16.0,
        ffmpeg="PyAV",
        ffmpeg_decode_ok=True,
        gpu_backend="cuda",
        ram_gb=32.0,
        full_precision=False,
    )
    values.update(changes)
    return doctor.DoctorReport(**values)


def test_the_doctor_knows_the_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    pc = report()
    assert pc.memory_plan().budget_bytes == 16 * GB and not pc.memory_plan().full_precision
    assert ("Memory for one model", "16.0 GB") in pc.lines()
    # With the GPU switched off, or broken, models run on the CPU: half of the machine's.
    assert pc.memory_plan(use_gpu=False).budget_bytes == 16 * GB
    assert pc.memory_plan(use_gpu=False).kind == "cpu"
    broken = report(cuda_available=False, ram_gb=8.0)
    assert broken.memory_plan().budget_bytes == 4 * GB and broken.memory_plan().full_precision
    mac = report(gpu_backend="mps", vram_gb=8.0, ram_gb=8.0, full_precision=True)
    assert mac.memory_plan().budget_bytes == int(4.5 * GB)
    assert report(cuda_available=False, ram_gb=None).memory_plan().budget_bytes is None
    monkeypatch.setenv("OPENSTEMS_MEMORY_GB", "6")
    assert pc.memory_plan().budget_bytes == 6 * GB
    assert ("Memory for one model", "6.0 GB (OPENSTEMS_MEMORY_GB=6)") in pc.lines()


# -- out of memory --------------------------------------------------------------------


def test_what_counts_as_out_of_memory() -> None:
    assert device.is_oom(torch.OutOfMemoryError("CUDA out of memory"))
    assert device.is_oom(RuntimeError(MPS_OOM))
    assert device.is_oom(MemoryError())
    assert device.is_oom(
        RuntimeError(
            "[enforce fail at alloc_cpu.cpp:121] data. DefaultCPUAllocator: not enough memory"
        )
    )
    assert not device.is_oom(RuntimeError("shape mismatch"))
    assert not device.is_oom(ValueError("out of memory"))
    # The pipeline has no device to go by when a load fails: MPS's wording counts anyway.
    assert device.is_oom(RuntimeError(MPS_BUFFER), "mps")
    assert run_module._out_of_memory(RuntimeError(MPS_BUFFER))
    assert run_module._out_of_memory(RuntimeError(MPS_OOM))
    assert run_module._out_of_memory(OutOfMemory("no room")) and run_module._out_of_memory(
        MemoryError()
    )
    assert not run_module._out_of_memory(RuntimeError("Invalid argument"))


class Scripted(FakeLoadedModel):
    """A model that fails the way its script says, and writes down where it ran."""

    log: list[str]
    failures: dict[tuple[str, str], Any]

    def separate(self, *args: Any, **kwargs: Any) -> Any:
        self.log.append(f"run {self.spec.id} on {self.device}")
        error = self.failures.get((self.spec.id, self.device))
        if callable(error):
            error = error()
        if isinstance(error, BaseException):
            raise error
        return super().separate(*args, **kwargs)


class ScriptedEngine(FakeEngine):
    def __init__(self, log: list[str], failures: dict, load_failures: dict | None = None) -> None:
        super().__init__(delay=0.0)
        self.log, self.failures = log, failures
        self.load_failures = {} if load_failures is None else load_failures

    def load(self, spec: Any, store: Any, device: str | None = None) -> Scripted:
        where = device or "gpu"
        self.log.append(f"load {spec.id} on {where}")
        error = self.load_failures.get((spec.id, where))
        if error is not None:
            raise error
        model = Scripted(spec, 0.0, where)
        model.log, model.failures = self.log, self.failures
        return model


@pytest.fixture
def scripted(catalog, store, monkeypatch: pytest.MonkeyPatch):
    """A pipeline whose models fail on cue. Returns (pipeline, log, run failures, load failures)."""
    log: list[str] = []
    failures: dict = {}
    load_failures: dict = {}
    engine = ScriptedEngine(log, failures, load_failures)
    monkeypatch.setattr(host, "engine_for", lambda spec: engine)
    return Pipeline(catalog, store), log, failures, load_failures


@pytest.mark.parametrize(
    "error",
    [
        lambda: torch.OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB"),
        lambda: RuntimeError(MPS_OOM),
        lambda: RuntimeError(MPS_BUFFER),
        lambda: OutOfMemory("no room"),
    ],
    ids=["cuda", "mps", "mps-buffer", "domain"],
)
def test_out_of_memory_clears_the_other_models_then_moves_to_the_cpu(
    scripted, song, tmp_path, error
) -> None:
    pipeline, log, failures, _ = scripted
    failures[("kit", "gpu")] = error
    messages: list[str] = []
    result = pipeline.run(
        song, drum_kit(), tmp_path / "out", progress=lambda p: messages.append(p.message)
    )
    assert log == [
        "load six on gpu",
        "run six on gpu",
        "load kit on gpu",
        "run kit on gpu",  # out of memory
        "load kit on gpu",  # the other warm model was dropped
        "run kit on gpu",  # still out of memory
        "load kit on cpu",
        "run kit on cpu",
    ]
    assert [s.name for s in result.stems] == ["kick"]
    note = f"kit {CPU_NOTE}"
    assert note == "kit ran on the CPU: not enough GPU memory"
    assert result.manifest["notes"] == [note]
    assert read_manifest(Path(result.directory))["notes"] == [note]  # type: ignore[index]
    models = result.manifest["passes"]["kit"]["models"]
    assert models[0]["device"] == "cpu"
    assert "device" not in result.manifest["passes"]["sw"]["models"][0]
    assert "Not enough GPU memory: kit runs on the CPU" in messages
    assert "kit: kit (on the CPU)" in messages
    # The CPU was for this job only.
    assert pipeline.host.loaded_ids == []
    again = pipeline.run(song, drum_kit(), tmp_path / "out")
    assert again.cached and again.manifest["notes"] == [note]


def test_a_retry_that_works_leaves_no_note(scripted, song, tmp_path) -> None:
    pipeline, log, failures, _ = scripted
    left = {"n": 1}

    def once() -> BaseException | None:
        if left["n"]:
            left["n"] -= 1
            return torch.OutOfMemoryError("CUDA out of memory")
        return None

    failures[("kit", "gpu")] = once
    result = pipeline.run(song, drum_kit(), tmp_path / "out")
    assert result.manifest["notes"] == []
    assert pipeline.host.loaded_ids == ["kit"]
    assert not any("cpu" in line for line in log)


def test_with_nothing_else_warm_it_goes_straight_to_the_cpu(scripted, song, tmp_path) -> None:
    pipeline, log, failures, _ = scripted
    failures[("vox", "gpu")] = lambda: RuntimeError(MPS_OOM)
    result = pipeline.run(song, one_model(), tmp_path / "out")
    assert log == ["load vox on gpu", "run vox on gpu", "load vox on cpu", "run vox on cpu"]
    assert result.manifest["notes"] == [f"vox {CPU_NOTE}"]


def test_a_model_that_cannot_be_loaded_for_lack_of_memory_takes_the_same_path(
    scripted, song, tmp_path
) -> None:
    pipeline, log, _, load_failures = scripted
    load_failures[("kit", "gpu")] = torch_common.EngineMemoryError("kit.ckpt: not enough memory")
    result = pipeline.run(song, drum_kit(), tmp_path / "out")
    assert log == [
        "load six on gpu",
        "run six on gpu",
        "load kit on gpu",  # fails
        "load kit on gpu",  # fails again with nothing else warm
        "load kit on cpu",
        "run kit on cpu",
    ]
    assert result.manifest["notes"] == [f"kit {CPU_NOTE}"]
    assert isinstance(load_failures[("kit", "gpu")], OutOfMemory)


def test_a_model_used_twice_stays_on_the_cpu_for_the_job(scripted, song, tmp_path) -> None:
    pipeline, log, failures, _ = scripted
    failures[("vox", "gpu")] = lambda: torch.OutOfMemoryError("CUDA out of memory")
    recipe = Recipe(
        id="twice",
        name="Twice",
        version=1,
        passes=(PassSpec("a", ("vox",)), PassSpec("b", ("vox",), input="a.vocals")),
        outputs=(OutputStem("vocals", "b.vocals"),),
    )
    result = pipeline.run(song, recipe, tmp_path / "out")
    assert log.count("run vox on gpu") == 1 and log.count("run vox on cpu") == 2
    assert log.count("load vox on cpu") == 1
    assert result.manifest["notes"] == [f"vox {CPU_NOTE}"]  # said once


def test_no_memory_on_the_cpu_either_is_a_plain_failure(scripted, song, tmp_path) -> None:
    pipeline, _, failures, _ = scripted
    failures[("vox", "gpu")] = lambda: torch.OutOfMemoryError("CUDA out of memory")
    failures[("vox", "cpu")] = lambda: MemoryError()
    with pytest.raises(DomainError, match="not enough memory to run this model, even on the CPU"):
        pipeline.run(song, one_model(), tmp_path / "out")
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").rglob("*.wav"))
    assert pipeline.host.loaded_ids == []


def test_other_errors_are_not_mistaken_for_memory(scripted, song, tmp_path) -> None:
    pipeline, log, failures, _ = scripted
    failures[("vox", "gpu")] = lambda: RuntimeError("size mismatch for layer.weight")
    with pytest.raises(RuntimeError, match="size mismatch"):
        pipeline.run(song, one_model(), tmp_path / "out")
    assert log == ["load vox on gpu", "run vox on gpu"]


def test_a_model_already_on_the_cpu_is_not_moved_there_again(
    catalog, store, song, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    log: list[str] = []

    class OnCpu(ScriptedEngine):
        def load(self, spec: Any, store: Any, device: str | None = None) -> Scripted:
            return super().load(spec, store, "cpu")

    engine = OnCpu(log, {("vox", "cpu"): lambda: MemoryError()})
    monkeypatch.setattr(host, "engine_for", lambda spec: engine)
    with pytest.raises(DomainError, match="not enough memory"):
        Pipeline(catalog, store).run(song, one_model(), tmp_path / "out")
    assert log == ["load vox on cpu", "run vox on cpu"]


class CpuEngine(ScriptedEngine):
    """A machine with no GPU: every model loads on the CPU."""

    def load(self, spec: Any, store: Any, device: str | None = None) -> Scripted:
        return super().load(spec, store, "cpu")


@pytest.fixture
def cpu_machine(catalog, store, monkeypatch: pytest.MonkeyPatch):
    log: list[str] = []
    failures: dict = {}
    load_failures: dict = {}
    engine = CpuEngine(log, failures, load_failures)
    monkeypatch.setattr(host, "engine_for", lambda spec: engine)
    pipeline = Pipeline(catalog, store)
    monkeypatch.setattr(pipeline.host, "loads_on_cpu", lambda spec: True)
    return pipeline, log, failures, load_failures


def test_on_the_cpu_the_other_warm_models_are_dropped_before_giving_up(
    cpu_machine, song, tmp_path
) -> None:
    pipeline, log, failures, _ = cpu_machine
    left = {"n": 1}

    def once() -> BaseException | None:
        if left["n"]:
            left["n"] -= 1
            return MemoryError()
        return None

    failures[("kit", "cpu")] = once
    result = pipeline.run(song, drum_kit(), tmp_path / "out")
    assert log == [
        "load six on cpu",
        "run six on cpu",
        "load kit on cpu",
        "run kit on cpu",  # out of memory, with the first model still warm
        "load kit on cpu",
        "run kit on cpu",
    ]
    # No GPU was involved, so nothing "ran on the CPU: not enough GPU memory".
    assert result.manifest["notes"] == []
    assert "device" not in result.manifest["passes"]["kit"]["models"][0]


def test_on_the_cpu_a_load_that_runs_out_is_not_moved_to_the_cpu(
    cpu_machine, song, tmp_path
) -> None:
    pipeline, log, _, load_failures = cpu_machine
    load_failures[("vox", "cpu")] = torch_common.EngineMemoryError("vox.ckpt: not enough memory")
    messages: list[str] = []
    with pytest.raises(DomainError, match="even on the CPU"):
        pipeline.run(
            song, one_model(), tmp_path / "out", progress=lambda p: messages.append(p.message)
        )
    assert log == ["load vox on cpu"]  # not loaded a second time
    assert not any("Not enough GPU memory" in m for m in messages)
    # With another model warm it is tried once more first.
    log.clear()
    load_failures.clear()
    load_failures[("kit", "cpu")] = torch_common.EngineMemoryError("kit.ckpt: not enough memory")
    with pytest.raises(DomainError, match="even on the CPU"):
        pipeline.run(song, drum_kit(), tmp_path / "out2")
    assert log == ["load six on cpu", "run six on cpu", "load kit on cpu", "load kit on cpu"]


def test_where_a_model_loads_without_being_told(catalog, monkeypatch: pytest.MonkeyPatch) -> None:
    models = host.ModelHost(None)  # type: ignore[arg-type]
    assert models.loads_on_cpu(catalog.get("vox")) is False  # the FakeEngine's pretend GPU
    real = type(catalog.get("vox"))(**{**catalog.get("vox").__dict__, "architecture": "mdx23c"})
    monkeypatch.setattr(torch_common, "pick_device", lambda: torch.device("cpu"))
    assert models.loads_on_cpu(real) is True
    monkeypatch.setattr(torch_common, "pick_device", lambda: torch.device("mps"))
    assert models.loads_on_cpu(real) is False
    monkeypatch.setenv("OPENSTEMS_ENGINE", "fake")
    monkeypatch.setattr(torch_common, "pick_device", lambda: torch.device("cpu"))
    assert models.loads_on_cpu(real) is False


def test_the_gpu_cache_is_emptied_even_when_the_load_never_finished(
    scripted, song, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pipeline, log, _, load_failures = scripted
    monkeypatch.setattr(device, "gpu_device_name", lambda: "mps")
    monkeypatch.setattr(device, "empty_cache", lambda d: log.append(f"empty {d}"))
    load_failures[("vox", "gpu")] = torch_common.EngineMemoryError("vox.ckpt: not enough memory")
    pipeline.run(song, one_model(), tmp_path / "out")
    # Nothing was warm, so the host had no model whose unload would empty the cache.
    assert log == ["load vox on gpu", "empty mps", "load vox on cpu", "run vox on cpu"]
    monkeypatch.setattr(device, "gpu_device_name", lambda: None)
    log.clear()
    pipeline.host.release()
    assert log == ["empty cpu"]  # nothing to do on a machine without a GPU


# -- the FakeEngine acts it out -------------------------------------------------------


def test_the_fake_engine_runs_out_of_memory_on_request(
    pipeline, song, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert fake.fake_oom("six") is None
    monkeypatch.setenv("OPENSTEMS_FAKE_OOM", "vox2:load, kit:once ,six")
    assert [fake.fake_oom(m) for m in ("six", "vox2", "kit", "vox")] == [
        "run",
        "load",
        "once",
        None,
    ]
    # "run": the pretend GPU never works, the CPU does.
    result = pipeline.run(song, one_model("six"), tmp_path / "a")
    assert result.manifest["notes"] == [f"six {CPU_NOTE}"]
    # "load": the same path from a failed load.
    result = pipeline.run(song, one_model("vox2"), tmp_path / "b")
    assert result.manifest["notes"] == [f"vox2 {CPU_NOTE}"]
    # "once": dropping the other warm model is enough.
    monkeypatch.setenv("OPENSTEMS_FAKE_OOM", "kit:once")
    result = pipeline.run(song, drum_kit(), tmp_path / "c")
    assert result.manifest["notes"] == [] and pipeline.host.loaded_ids == ["kit"]
    # "always": the CPU fails too, and so does the job.
    monkeypatch.setenv("OPENSTEMS_FAKE_OOM", "all:always")
    with pytest.raises(DomainError, match="even on the CPU"):
        pipeline.run(song, one_model("vox"), tmp_path / "d")


# -- warm models on a small machine ---------------------------------------------------


def test_a_small_machine_keeps_one_model_warm(
    catalog, store, monkeypatch: pytest.MonkeyPatch
) -> None:
    roomy = host.ModelHost(store)
    roomy.get(catalog.get("six"))
    roomy.get(catalog.get("kit"))
    assert roomy.loaded_ids == ["six", "kit"] and not roomy.small

    monkeypatch.setenv("OPENSTEMS_MEMORY_GB", "8")
    small = host.ModelHost(store)
    small.get(catalog.get("six"))
    small.get(catalog.get("kit"))
    assert small.loaded_ids == ["kit"] and small.small
    small.get(catalog.get("kit"))
    assert small.loads == 2  # the warm one is still reused


def test_a_small_machine_lets_go_of_its_model_sooner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENSTEMS_IDLE_UNLOAD_SECONDS", raising=False)
    assert idle_unload_seconds() == IDLE_UNLOAD_SECONDS == 600
    assert idle_unload_seconds(small=True) == SMALL_IDLE_UNLOAD_SECONDS == 60
    monkeypatch.setenv("OPENSTEMS_IDLE_UNLOAD_SECONDS", "5")
    assert idle_unload_seconds(small=True) == 5


def test_the_warm_cap_never_exceeds_the_run_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    assert build_runtime().pipeline.host.budget == 12 * GB  # the setting, as before
    monkeypatch.setattr(settings, "_is_mac", lambda: True)
    monkeypatch.setenv("OPENSTEMS_MEMORY_GB", "8")
    assert build_runtime().pipeline.host.budget == 4 * GB


# -- loading checkpoints --------------------------------------------------------------


def test_checkpoints_are_mapped_not_read_twice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = torch.nn.Linear(8, 4)
    path = tmp_path / "model.ckpt"
    torch.save({"state_dict": source.state_dict()}, path)
    calls: list[dict[str, Any]] = []
    real = torch.load

    def spy(*args: Any, **kwargs: Any) -> Any:
        calls.append(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(torch, "load", spy)
    state = torch_common.load_state_dict(path)
    assert [c.get("mmap") for c in calls] == [True]
    assert all(c["weights_only"] is True for c in calls)
    assert set(state) == {"weight", "bias"}

    monkeypatch.setattr(torch_common, "ensure_stft", lambda d: None)
    module = torch.nn.Linear(8, 4)
    loaded = torch_common.finish_load(
        fake_spec("m", ("vocals",)), module, state, ("vocals",), device="cpu"
    )
    assert loaded.device.type == "cpu"
    assert torch.equal(module.weight, source.weight) and torch.equal(module.bias, source.bias)
    assert state == {}  # the model holds the weights now: no second copy is kept
    path.unlink()  # and the file is let go, which Windows would refuse for a mapped file
    assert torch.equal(module.weight, source.weight)  # still readable with the file gone


def test_an_old_format_checkpoint_is_read_whole(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = torch.nn.Linear(8, 4)
    path = tmp_path / "old.ckpt"
    torch.save(source.state_dict(), path, _use_new_zipfile_serialization=False)
    calls: list[Any] = []
    real = torch.load

    def spy(*args: Any, **kwargs: Any) -> Any:
        calls.append(kwargs.get("mmap"))
        return real(*args, **kwargs)

    monkeypatch.setattr(torch, "load", spy)
    state = torch_common.load_state_dict(path)
    assert calls == [True, None]  # mapping was refused, the plain read worked
    assert torch.equal(state["weight"], source.weight)


def test_a_checkpoint_too_large_for_memory_is_an_out_of_memory_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "big.ckpt"
    torch.save(torch.nn.Linear(2, 2).state_dict(), path)

    def no_room(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("[enforce fail at alloc_cpu.cpp] DefaultCPUAllocator: not enough memory")

    monkeypatch.setattr(torch, "load", no_room)
    with pytest.raises(torch_common.EngineMemoryError) as caught:
        torch_common.load_state_dict(path)
    assert isinstance(caught.value, OutOfMemory) and isinstance(caught.value, DomainError)

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("PytorchStreamReader failed reading zip archive")

    monkeypatch.setattr(torch, "load", broken)
    with pytest.raises(torch_common.EngineError) as caught:
        torch_common.load_state_dict(path)
    assert not isinstance(caught.value, OutOfMemory)


# -- the API, with a real worker process ----------------------------------------------


@pytest.fixture
def fake_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENSTEMS_ENGINE", "fake")
    monkeypatch.setenv("OPENSTEMS_AUTO_START", "1")


def start(service: Service) -> TestClient:
    return TestClient(create_app(TOKEN, service), headers=AUTH)


def finished(client: TestClient, timeout: float = 30.0) -> list[dict[str, Any]]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        jobs = client.get("/v1/jobs").json()["jobs"]
        if jobs and all(j["state"] in ("done", "failed", "cancelled") for j in jobs):
            return jobs
        time.sleep(0.05)
    raise AssertionError("timed out")


@pytest.fixture
def one_song(tmp_path: Path) -> Path:
    from openstems.audio.write import write_audio

    path = tmp_path / "in" / "Song.wav"
    path.parent.mkdir()
    write_audio(path, tone(0.4), RATE)
    return path


def test_the_api_on_a_machine_that_does_not_say_how_large_it_is(fake_env: None) -> None:
    service = Service()
    with start(service) as client:
        system = client.get("/v1/system").json()
        assert system["memory_budget_gb"] is None and system["memory_gb"] is None
        assert system["memory_overridden"] is False
        models = client.get("/v1/models").json()["models"]
        assert {m["fit"] for m in models} == {"fits"}
        assert [m["id"] for m in models if m["recommended"]] == [
            m["id"] for m in models if m["seed"]
        ]
        recipes = client.get("/v1/recipes").json()["recipes"]
        assert {r["fit"] for r in recipes} == {"fits"}


def test_the_api_on_a_small_machine(fake_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENSTEMS_MEMORY_GB", "8")
    service = Service()
    with start(service) as client:
        system = client.get("/v1/system").json()
        # The FakeEngine has no GPU: the CPU's rule, half of the 8 GB.
        assert system["memory_gb"] == 8.0 and system["memory_budget_gb"] == 4.0
        assert system["memory_overridden"] is True

        models = {m["id"]: m for m in client.get("/v1/models").json()["models"]}
        sw = models["bs-roformer-sw"]
        assert sw["fit"] == "tight" and sw["memory_estimated"] is True
        assert 3.9 < sw["memory_gb"] < 4.1
        assert models["mel-roformer-guitar-becruily"]["fit"] == "fits"
        assert models["bs-roformer-leap-xe-vocals"]["fit"] == "no"
        assert models["bs-roformer-leap-xe-vocals"]["recommended"] is False
        assert models["mel-roformer-vocals-becruily"]["recommended"] is True
        assert all(m["fit"] != "no" for m in models.values() if m["recommended"])
        one = client.post("/v1/models/bs-roformer-sw/verify")
        assert one.status_code == 200

        recipes = {r["id"]: r for r in client.get("/v1/recipes").json()["recipes"]}
        full = recipes["full-song"]
        assert (full["fit"], full["fit_model"]) == ("tight", "bs-roformer-sw")
        assert full["memory_gb"] == sw["memory_gb"]
        best = recipes["full-song-best-vocals"]
        assert (best["fit"], best["fit_model"]) == ("no", "bs-roformer-leap-xe-vocals")
        assert recipes["mega-53"]["fit"] == "no"


def test_a_job_that_runs_out_of_memory_finishes_on_the_cpu_with_a_note(
    fake_env: None, one_song: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENSTEMS_FAKE_OOM", "bs-roformer-sw")
    note = "BS-RoFormer SW ran on the CPU: not enough GPU memory"
    service = Service()
    with start(service) as client:
        assert service.jobs.supervisor.ready.wait(30)
        created = client.post("/v1/jobs", json={"path": str(one_song), "recipe": "full-song"})
        assert created.status_code == 200 and created.json()["notes"] == []
        job = finished(client)[0]
        assert job["state"] == "done" and len(job["stems"]) == 6
        assert job["notes"] == [note]
        manifest = json.loads((Path(job["output_dir"]) / "manifest.json").read_text("utf-8"))
        assert manifest["notes"] == [note]
    # The note survives a restart.
    with start(Service()) as client:
        assert client.get("/v1/jobs").json()["jobs"][0]["notes"] == [note]


def test_a_model_marked_no_may_still_be_run(
    fake_env: None, one_song: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENSTEMS_MEMORY_GB", "4")
    service = Service()
    with start(service) as client:
        assert service.jobs.supervisor.ready.wait(30)
        models = {m["id"]: m for m in client.get("/v1/models").json()["models"]}
        assert models["bs-roformer-sw"]["fit"] == "no"
        client.post("/v1/jobs", json={"path": str(one_song), "recipe": "full-song"})
        job = finished(client)[0]
        assert job["state"] == "done" and job["notes"] == []


def test_no_memory_anywhere_fails_the_job_in_plain_words(
    fake_env: None, one_song: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENSTEMS_FAKE_OOM", "all:always")
    service = Service()
    with start(service) as client:
        assert service.jobs.supervisor.ready.wait(30)
        client.post("/v1/jobs", json={"path": str(one_song), "recipe": "full-song"})
        job = finished(client)[0]
        assert job["state"] == "failed" and job["notes"] == []
        assert "not enough memory to run this model, even on the CPU" in job["error"]


# -- the API on a real machine: the doctor runs in a process of its own ---------------


def test_the_api_process_does_not_import_torch() -> None:
    import subprocess

    code = (
        "import sys, openstems.api.app, openstems.api.service, openstems.doctor; "
        "sys.exit(1 if 'torch' in sys.modules else 0)"
    )
    assert subprocess.run([sys.executable, "-c", code], check=False).returncode == 0


def test_the_doctor_report_round_trips_through_json() -> None:
    pc = report(problems=["a problem"], notes=["a note"])
    data = json.loads(json.dumps(pc.to_dict()))
    assert doctor.DoctorReport.from_dict({**data, "added_later": 1}) == pc
    with pytest.raises(TypeError):
        doctor.DoctorReport.from_dict({"python": "3.12"})


def test_the_budget_comes_from_a_doctor_in_its_own_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runs: list[float] = []

    def stand_in(timeout: float = 120.0) -> doctor.DoctorReport:
        runs.append(timeout)
        return report(vram_gb=6.0, gpu_name="A 6 GB card")

    monkeypatch.setattr(service_module, "run_doctor_process", stand_in)
    monkeypatch.setattr(doctor, "run_doctor", lambda: pytest.fail("the doctor ran in-process"))
    service = Service()
    try:
        system = service.system()
        assert (system["memory_kind"], system["memory_budget_gb"]) == ("cuda", 6.0)
        assert system["gpu_name"] == "A 6 GB card" and system["problems"] == []
        models = {m["id"]: m for m in service.models()["models"]}
        assert models["bs-roformer-leap-xe-vocals"]["fit"] == "fits"
        assert models["bs-roformer-mega-53"]["fit"] == "no"
        service.recipes()
        assert len(runs) == 1  # asked once, however many requests need it
        # With the GPU switched off the same report gives the CPU's budget, and says so.
        monkeypatch.setenv("OPENSTEMS_DEVICE", "cpu")
        system = service.system()
        assert (system["memory_kind"], system["memory_budget_gb"]) == ("cpu", 16.0)
        assert len(runs) == 1
    finally:
        service.index.close()

    # The next start reads the kept report: no request waits for the doctor.
    monkeypatch.delenv("OPENSTEMS_DEVICE")
    again = Service()
    try:
        kept = again._read_machine()
        assert kept is not None and kept.gpu_name == "A 6 GB card"
        again._doctor = kept
        assert again.system()["memory_budget_gb"] == 6.0 and len(runs) == 1
        # It is checked again in the background. The same machine changes nothing,
        events: list[str] = []
        monkeypatch.setattr(again.bus, "publish", lambda kind, **data: events.append(kind))
        again._refresh_machine()
        assert len(runs) == 2 and events == []
        again._refresh_machine()
        assert len(runs) == 2  # once per start
        # a changed one replaces what was kept and tells the app to ask again.
        monkeypatch.setattr(
            service_module, "run_doctor_process", lambda: report(vram_gb=4.0, gpu_name="Smaller")
        )
        again._examined = False
        again._refresh_machine()
        assert events == ["worker.status", "models.changed"]
        assert again.system()["memory_budget_gb"] == 4.0
        assert again._read_machine().gpu_name == "Smaller"  # type: ignore[union-attr]
        # A report kept by another version is not trusted.
        path = again._machine_file()
        path.write_text(path.read_text("utf-8").replace('"version": "', '"version": "0.'), "utf-8")
        assert again._read_machine() is None
        path.write_text("not json", "utf-8")
        assert again._read_machine() is None
    finally:
        again.index.close()


def test_a_first_start_waits_for_the_doctor_once(monkeypatch: pytest.MonkeyPatch) -> None:
    runs: list[int] = []

    def stand_in() -> doctor.DoctorReport:
        runs.append(1)
        return report()

    monkeypatch.setattr(service_module, "run_doctor_process", stand_in)
    service = Service()
    try:
        assert service._read_machine() is None
        service._refresh_machine()  # nothing kept: this is the check the requests wait for
        assert service.system()["memory_budget_gb"] == 16.0
        service._refresh_machine()
        assert len(runs) == 1
    finally:
        service.index.close()


def test_a_doctor_that_does_not_finish_leaves_the_cpu_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        service_module, "_cli_json", lambda args, timeout: (None, ["crashed (exit code 3).", "x"])
    )
    monkeypatch.setattr(service_module, "physical_memory_bytes", lambda: 16 * GB)
    failed = service_module.run_doctor_process()
    assert failed.problems == ["The system check crashed (exit code 3).", "x"]
    assert failed.torch is None and not failed.cuda_available
    assert failed.memory_plan().kind == "cpu" and failed.memory_plan().budget_bytes == 8 * GB
    service = Service()
    try:
        assert service.system()["memory_budget_gb"] == 8.0
        assert service._read_machine() is None  # not kept: the next start looks again
    finally:
        service.index.close()
    # A report this version cannot read is the same kind of failure.
    monkeypatch.setattr(service_module, "_cli_json", lambda args, timeout: ({"python": "3"}, []))
    assert "unexpected report" in service_module.run_doctor_process().problems[0]
