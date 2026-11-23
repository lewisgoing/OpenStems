"""MDX23C (TFC-TDF) adapter: model class from mdxnet-infer, shared runner."""

from __future__ import annotations

from openstems.catalog.store import ModelStore
from openstems.domain.model import ModelSpec
from openstems.engines.torch_common import (
    TorchLoadedModel,
    config_stems,
    finish_load,
    load_device,
    load_state_dict,
    load_yaml,
    quiet_stdout,
    require_paths,
)


class MDX23CEngine:
    name = "mdxnet-infer"

    def load(
        self, spec: ModelSpec, store: ModelStore, device: str | None = None
    ) -> TorchLoadedModel:
        from mdxnet_infer.config import MDX23CConfig
        from mdxnet_infer.model import TFC_TDF_net

        checkpoint, config_path = require_paths(spec, store)
        raw = load_yaml(config_path)
        # The network builds its STFT window on a device at construction time.
        target = load_device(device)
        with quiet_stdout():
            module = TFC_TDF_net(MDX23CConfig.from_mapping(raw), target)
        return finish_load(
            spec, module, load_state_dict(checkpoint), config_stems(raw), device=device
        )
