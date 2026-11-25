"""FakeEngine: deterministic, CPU-only, no model files. For tests and UI development."""

from __future__ import annotations

import os
import time

import numpy as np

from openstems.catalog.store import ModelStore
from openstems.domain.errors import OutOfMemory
from openstems.domain.model import ModelSpec
from openstems.domain.quality import RunSettings
from openstems.engines.base import CancelToken, ProgressFn


def fake_gains(count: int) -> list[float]:
    """Per-stem gains that sum to less than 1, so the stems leave a residual."""
    total = count * (count + 1) / 2 + 1
    return [(i + 1) / total for i in range(count)]


FAKE_GPU = "gpu"
_once: set[str] = set()  # models whose one-off failure has happened in this process
# The rate the pipeline hands an engine its mix at (`pipeline.run.SAMPLE_RATE`).
_RATE = 44100


def fake_late() -> dict[str, float]:
    """Stems the FakeEngine leaves silent at their start, from ``OPENSTEMS_FAKE_LATE``: a
    comma-separated list of ``<stem>:<seconds>``. With trim_silence on, such a stem's file
    begins later in the song (its ``start``), as a real stem that enters late does. Only the
    trimmer's end-to-end test sets it."""
    late: dict[str, float] = {}
    for item in os.environ.get("OPENSTEMS_FAKE_LATE", "").split(","):
        name, _, seconds = item.strip().partition(":")
        try:
            if name:
                late[name] = max(0.0, float(seconds))
        except ValueError:
            continue
    return late


def fake_empty() -> set[str]:
    """Stems the FakeEngine leaves empty, from ``OPENSTEMS_FAKE_EMPTY`` (comma-separated
    names): a hiss 60 dB under what the stem would hold, as a real model leaves in the
    guitar stem of a song without a guitar."""
    names = os.environ.get("OPENSTEMS_FAKE_EMPTY", "").split(",")
    return {name.strip() for name in names if name.strip()}


def fake_oom(model_id: str) -> str | None:
    """How a model should run out of memory, from ``OPENSTEMS_FAKE_OOM``.

    The value is a comma-separated list of ``<model id>`` or ``<model id>:<mode>``; ``all``
    stands for every model. Modes:

    - ``run`` (the default): every run on the pretend GPU fails; the CPU works.
    - ``load``: loading on the pretend GPU fails; the CPU works.
    - ``once``: the first run on the pretend GPU fails, later ones work.
    - ``always``: every run fails, on the CPU too.
    """
    for item in os.environ.get("OPENSTEMS_FAKE_OOM", "").split(","):
        name, _, mode = item.strip().partition(":")
        if name and name in (model_id, "all"):
            return mode or "run"
    return None


class PagingFileFull(OSError):
    """What Windows raises while loading a library when its paging file is full."""

    winerror = 1455


_broken: list[str] = []  # the model whose load broke this process (`fake_import_fails`)


def fake_import_fails(model_id: str) -> None:
    """Act out PyTorch's import failing, from ``OPENSTEMS_FAKE_IMPORT_FAILS`` (comma-separated
    model ids, or ``all``): loading one of those models fails as the import does on Windows
    with its paging file full. The process is then left as a real one is, with half of
    PyTorch loaded: every load after it fails, whatever the model, with the error that
    gives. A fresh process loads again."""
    if _broken:
        raise AttributeError("module 'torch' has no attribute 'device' (FakeEngine)")
    for item in os.environ.get("OPENSTEMS_FAKE_IMPORT_FAILS", "").split(","):
        name = item.strip()
        if name and name in (model_id, "all"):
            _broken.append(model_id)
            raise PagingFileFull(
                "[WinError 1455] The paging file is too small for this operation to complete. "
                'Error loading "torch_cuda.dll" or one of its dependencies. (FakeEngine)'
            )


class FakeLoadedModel:
    vram_bytes = 0

    def __init__(self, spec: ModelSpec, delay: float, device: str = FAKE_GPU) -> None:
        self.spec = spec
        self.delay = delay
        self.device = device  # "gpu" (pretend) or "cpu"
        self.runs = 0

    def _maybe_run_out(self) -> None:
        mode = fake_oom(self.spec.id)
        if mode == "always" or (mode == "run" and self.device != "cpu"):
            raise OutOfMemory(f"{self.spec.id}: out of memory (FakeEngine)")
        if mode == "once" and self.device != "cpu" and self.spec.id not in _once:
            _once.add(self.spec.id)
            raise OutOfMemory(f"{self.spec.id}: out of memory (FakeEngine)")

    def separate(
        self,
        mix: np.ndarray,
        settings: RunSettings,
        progress: ProgressFn | None = None,
        cancel: CancelToken | None = None,
        only: frozenset[str] | None = None,
    ) -> dict[str, np.ndarray]:
        self.runs += 1
        self._maybe_run_out()
        samples = mix.shape[1]
        step = max(1, settings.chunk_size // max(1, settings.num_overlap))
        chunks = max(1, -(-samples // step))
        for i in range(chunks):
            if cancel is not None:
                cancel.raise_if_cancelled()
            if self.delay:
                time.sleep(self.delay)
            if progress is not None:
                progress((i + 1) / chunks)
        gains = fake_gains(len(self.spec.stems))
        out = {
            name: (mix * np.float32(gain)).astype(np.float32)
            for name, gain in zip(self.spec.stems, gains, strict=True)
            if only is None or name in only
        }
        for name, seconds in fake_late().items():
            if name in out:
                out[name][:, : round(seconds * _RATE)] = 0.0
        for name in fake_empty():
            if name in out:
                out[name] *= np.float32(0.001)
        return out

    def unload(self) -> None:
        pass


class FakeEngine:
    """Splits the input into scaled copies. Honors progress and cancel like a real engine.

    ``OPENSTEMS_FAKE_DELAY`` (seconds per chunk) slows it down so queues can be observed.
    ``OPENSTEMS_FAKE_OOM`` makes chosen models run out of memory (`fake_oom`), so the
    low-memory path can be acted out without a GPU. ``OPENSTEMS_FAKE_LATE`` leaves chosen
    stems silent at their start (`fake_late`) and ``OPENSTEMS_FAKE_EMPTY`` leaves chosen
    stems empty (`fake_empty`). ``OPENSTEMS_FAKE_IMPORT_FAILS`` acts out a
    failed import of PyTorch that breaks the process (`fake_import_fails`).
    """

    name = "fake"

    def __init__(self, delay: float | None = None) -> None:
        self.delay = float(os.environ.get("OPENSTEMS_FAKE_DELAY", "0")) if delay is None else delay
        self.loads = 0

    def load(
        self, spec: ModelSpec, store: ModelStore, device: str | None = None
    ) -> FakeLoadedModel:
        self.loads += 1
        fake_import_fails(spec.id)
        if fake_oom(spec.id) == "load" and device != "cpu":
            raise OutOfMemory(f"{spec.id}: not enough memory to load the model (FakeEngine)")
        return FakeLoadedModel(spec, self.delay, device or FAKE_GPU)
