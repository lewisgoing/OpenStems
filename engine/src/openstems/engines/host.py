"""Engine lookup and the model host that keeps loaded models warm."""

from __future__ import annotations

import gc
import os
import sys
from collections import OrderedDict

from openstems.catalog.store import ModelStore
from openstems.domain.errors import DomainError
from openstems.domain.memory import MemoryPlan, plan_memory
from openstems.domain.model import ModelSpec
from openstems.engines.base import Engine, LoadedModel
from openstems.engines.fake import FakeEngine
from openstems.procutil import memory_override_bytes


def fake_mode() -> bool:
    return os.environ.get("OPENSTEMS_ENGINE", "").lower() == "fake"


def engine_for(spec: ModelSpec) -> Engine:
    """The adapter for a model's loader. Torch is imported only when a real engine is needed."""
    if fake_mode() or spec.architecture == "fake":
        return FakeEngine()
    if spec.architecture == "bs_roformer":
        from openstems.engines.bs_roformer import BSRoformerEngine

        return BSRoformerEngine()
    if spec.architecture == "mel_band_roformer":
        from openstems.engines.mel_band_roformer import MelBandRoformerEngine

        return MelBandRoformerEngine()
    if spec.architecture == "mdx23c":
        from openstems.engines.mdx23c import MDX23CEngine

        return MDX23CEngine()
    raise DomainError(f"no engine for architecture {spec.architecture!r}")


def memory_plan(fake: bool = False) -> MemoryPlan:
    """The machine's memory for one model run, on the device models are loaded on now.
    With the FakeEngine there is no device: only ``OPENSTEMS_MEMORY_GB`` gives it a budget,
    by the CPU's rule, so tests see the same machine everywhere."""
    if fake or fake_mode():
        return plan_memory("cpu", None, True, memory_override_bytes())
    from openstems.engines.device import memory_plan as device_plan
    from openstems.engines.torch_common import pick_device

    return device_plan(pick_device())


class ModelHost:
    """Keeps recently used models loaded and evicts the least recently used ones
    when the weights would exceed the VRAM budget. The last model always stays warm.

    The budget is the setting, or the machine's budget for one run when that is smaller.
    A small machine (`domain.memory.is_small`) keeps one model warm at most."""

    def __init__(self, store: ModelStore, vram_budget_bytes: int = 12 * 1024**3) -> None:
        self.store = store
        self.budget = vram_budget_bytes
        self._loaded: OrderedDict[str, LoadedModel] = OrderedDict()
        self._devices: dict[str, str | None] = {}
        self.loads = 0
        self.small = False  # as of the last load

    @property
    def loaded_ids(self) -> list[str]:
        return list(self._loaded)

    def get(self, spec: ModelSpec, device: str | None = None) -> LoadedModel:
        """The loaded model, loading it if need be. ``device`` forces where ("cpu"); a
        model that is warm somewhere else is loaded again."""
        if spec.id in self._loaded:
            if self._devices.get(spec.id) == device:
                self._loaded.move_to_end(spec.id)
                return self._loaded[spec.id]
            self.evict(spec.id)
        plan = memory_plan(fake=spec.architecture == "fake")
        budget = self.budget if plan.budget_bytes is None else min(self.budget, plan.budget_bytes)
        self.small = plan.small
        if self.small:
            self.clear()
        # Make room before loading: weights on the GPU are about the checkpoint's size.
        incoming = spec.checkpoint.size
        while self._loaded and self._used() + incoming > budget:
            self._evict_oldest()
        engine = engine_for(spec)
        if device is None:
            model = engine.load(spec, self.store)
        else:
            model = engine.load(spec, self.store, device=device)
        self.loads += 1
        self._loaded[spec.id] = model
        self._devices[spec.id] = device
        while len(self._loaded) > 1 and self._used() > budget:
            self._evict_oldest()
        return model

    def _used(self) -> int:
        return sum(m.vram_bytes for m in self._loaded.values())

    def _evict_oldest(self) -> None:
        model_id, model = self._loaded.popitem(last=False)
        self._devices.pop(model_id, None)
        model.unload()

    def evict(self, model_id: str) -> None:
        model = self._loaded.pop(model_id, None)
        self._devices.pop(model_id, None)
        if model is not None:
            model.unload()

    def clear(self) -> None:
        while self._loaded:
            self._evict_oldest()

    def release(self) -> None:
        """Drop every warm model and hand their memory back, after a run or a load ran out.
        A model that failed while loading never reached the host, so the GPU's cache is
        emptied here too, once the collector has freed what was left of it."""
        self.clear()
        gc.collect()
        # A process that never imported torch has no GPU cache.
        if "torch" in sys.modules:
            from openstems.engines.device import empty_cache, gpu_device_name

            empty_cache(gpu_device_name() or "cpu")

    def loads_on_cpu(self, spec: ModelSpec) -> bool:
        """Whether this model loads on the CPU without being told to: no GPU, or the GPU
        switched off. The FakeEngine's default device is a pretend GPU."""
        if fake_mode() or spec.architecture == "fake":
            return False
        from openstems.engines.torch_common import pick_device

        return pick_device().type == "cpu"
