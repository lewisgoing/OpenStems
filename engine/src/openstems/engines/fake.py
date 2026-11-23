"""FakeEngine: deterministic, CPU-only, no model files. For tests and UI development."""

from __future__ import annotations

import os
import time

import numpy as np

from openstems.catalog.store import ModelStore
from openstems.domain.model import ModelSpec
from openstems.domain.quality import RunSettings
from openstems.engines.base import CancelToken, ProgressFn


def fake_gains(count: int) -> list[float]:
    """Per-stem gains that sum to less than 1, so the stems leave a residual."""
    total = count * (count + 1) / 2 + 1
    return [(i + 1) / total for i in range(count)]


class FakeLoadedModel:
    vram_bytes = 0

    def __init__(self, spec: ModelSpec, delay: float) -> None:
        self.spec = spec
        self.delay = delay
        self.runs = 0

    def separate(
        self,
        mix: np.ndarray,
        settings: RunSettings,
        progress: ProgressFn | None = None,
        cancel: CancelToken | None = None,
        only: frozenset[str] | None = None,
    ) -> dict[str, np.ndarray]:
        self.runs += 1
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
        return {
            name: (mix * np.float32(gain)).astype(np.float32)
            for name, gain in zip(self.spec.stems, gains, strict=True)
            if only is None or name in only
        }

    def unload(self) -> None:
        pass


class FakeEngine:
    """Splits the input into scaled copies. Honors progress and cancel like a real engine.

    ``OPENSTEMS_FAKE_DELAY`` (seconds per chunk) slows it down so queues can be observed.
    """

    name = "fake"

    def __init__(self, delay: float | None = None) -> None:
        self.delay = float(os.environ.get("OPENSTEMS_FAKE_DELAY", "0")) if delay is None else delay
        self.loads = 0

    def load(self, spec: ModelSpec, store: ModelStore) -> FakeLoadedModel:
        self.loads += 1
        return FakeLoadedModel(spec, self.delay)
