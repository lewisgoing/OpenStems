"""Engine lookup and the model host that keeps loaded models warm."""

from __future__ import annotations

import os
from collections import OrderedDict

from openstems.catalog.store import ModelStore
from openstems.domain.errors import DomainError
from openstems.domain.model import ModelSpec
from openstems.engines.base import Engine, LoadedModel
from openstems.engines.fake import FakeEngine


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


class ModelHost:
    """Keeps recently used models loaded and evicts the least recently used ones
    when the weights would exceed the VRAM budget. The last model always stays warm."""

    def __init__(self, store: ModelStore, vram_budget_bytes: int = 12 * 1024**3) -> None:
        self.store = store
        self.budget = vram_budget_bytes
        self._loaded: OrderedDict[str, LoadedModel] = OrderedDict()
        self.loads = 0

    @property
    def loaded_ids(self) -> list[str]:
        return list(self._loaded)

    def get(self, spec: ModelSpec) -> LoadedModel:
        if spec.id in self._loaded:
            self._loaded.move_to_end(spec.id)
            return self._loaded[spec.id]
        # Make room before loading: weights on the GPU are about the checkpoint's size.
        incoming = spec.checkpoint.size
        while self._loaded and self._used() + incoming > self.budget:
            self._evict_oldest()
        model = engine_for(spec).load(spec, self.store)
        self.loads += 1
        self._loaded[spec.id] = model
        while len(self._loaded) > 1 and self._used() > self.budget:
            self._evict_oldest()
        return model

    def _used(self) -> int:
        return sum(m.vram_bytes for m in self._loaded.values())

    def _evict_oldest(self) -> None:
        _, model = self._loaded.popitem(last=False)
        model.unload()

    def evict(self, model_id: str) -> None:
        model = self._loaded.pop(model_id, None)
        if model is not None:
            model.unload()

    def clear(self) -> None:
        while self._loaded:
            self._evict_oldest()
