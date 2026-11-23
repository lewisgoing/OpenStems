"""BS-RoFormer adapter: model classes from bs-roformer-infer, inference by the shared runner."""

from __future__ import annotations

from ml_collections import ConfigDict

from openstems.catalog.store import ModelStore
from openstems.domain.model import ModelSpec
from openstems.engines.torch_common import (
    EngineError,
    TorchLoadedModel,
    config_stems,
    finish_load,
    load_state_dict,
    load_yaml,
    quiet_stdout,
    require_paths,
)


class BSRoformerEngine:
    name = "bs-roformer-infer"

    def load(
        self, spec: ModelSpec, store: ModelStore, device: str | None = None
    ) -> TorchLoadedModel:
        from bs_roformer.utils import get_model_from_config

        checkpoint, config_path = require_paths(spec, store)
        raw = load_yaml(config_path)
        with quiet_stdout():
            module = get_model_from_config(
                "bs_roformer", ConfigDict(raw), model_variation=spec.variation
            )
        if module is None:
            raise EngineError(f"{spec.id}: the loader could not build the model")
        return finish_load(
            spec, module, load_state_dict(checkpoint), config_stems(raw), device=device
        )
