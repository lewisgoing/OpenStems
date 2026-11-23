"""Shared pieces of the torch adapters: device choice, safe checkpoint loading, YAML."""

from __future__ import annotations

import contextlib
import io
import os
import pickle
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import torch
import yaml

from openstems.catalog.store import ModelStore
from openstems.domain.errors import DomainError
from openstems.domain.model import ModelSpec
from openstems.domain.quality import RunSettings
from openstems.engines.base import CancelToken, ProgressFn
from openstems.engines.runner import ModelFn, run_model
from openstems.settings import load_settings

# The loaders call torch.stft without a window on purpose and still use a deprecated
# attention context manager; neither is something the user can act on.
warnings.filterwarnings("ignore", message="A window was not provided")
warnings.filterwarnings("ignore", message=".*sdp_kernel.*", category=FutureWarning)
warnings.filterwarnings("ignore", message="stft with return_complex=False is deprecated")


class EngineError(DomainError):
    pass


@contextlib.contextmanager
def quiet_stdout():
    """The loader libraries print while building models; keep that off the CLI."""
    with contextlib.redirect_stdout(io.StringIO()):
        yield


class SafeLoaderWithTuple(yaml.SafeLoader):
    """Training configs carry ``!!python/tuple``; read those as lists, execute nothing."""


SafeLoaderWithTuple.add_constructor(
    "tag:yaml.org,2002:python/tuple",
    lambda loader, node: loader.construct_sequence(node),  # pyright: ignore[reportArgumentType]
)


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = yaml.load(handle, Loader=SafeLoaderWithTuple)
    if not isinstance(data, dict):
        raise EngineError(f"{path.name}: config is not a mapping")
    return data


def gpu_allowed() -> bool:
    """False when the user or the environment asked to stay on the CPU."""
    forced = os.environ.get("OPENSTEMS_DEVICE", "").strip().lower()
    if forced:
        return forced != "cpu"
    return load_settings().use_gpu


def arch_supported(capability: tuple[int, int], arch_list: list[str]) -> bool:
    """Whether a CUDA build of PyTorch has kernels for a card.

    ``capability`` is the card's compute capability, such as (6, 1) for a GTX 1060.
    ``arch_list`` is what the build was compiled for, such as ``["sm_75", "sm_80"]``. A build
    for sm_XY runs on a card of the same major version and the same or a later minor one.
    A build that names no architectures (AMD's) is taken at its word.
    """
    built = []
    for arch in arch_list:
        digits = arch.removeprefix("sm_")
        if arch.startswith("sm_") and digits.isdigit() and len(digits) >= 2:
            built.append((int(digits[:-1]), int(digits[-1])))
    if not built:
        return True
    major, minor = capability
    return any(m == major and n <= minor for m, n in built)


def card_supported() -> bool:
    """The first GPU is one this PyTorch build can run. An old card on the standard build,
    or a new card on the build for old cards, is present but unusable."""
    try:
        # Only ask about a card that is really there: on a machine with none, the query
        # itself can bring the process down.
        if torch.cuda.device_count() < 1:
            return True
        return arch_supported(torch.cuda.get_device_capability(0), torch.cuda.get_arch_list())
    except Exception:
        return True


def pick_device() -> torch.device:
    """The first GPU, for NVIDIA (CUDA) and AMD (ROCm) builds alike: both answer through
    ``torch.cuda``. The CPU when there is none, when the GPU is switched off, or when this
    PyTorch build has no kernels for the card."""
    if gpu_allowed() and torch.cuda.is_available() and card_supported():
        return torch.device("cuda:0")
    return torch.device("cpu")


def load_state_dict(path: Path) -> dict[str, Any]:
    """Load a checkpoint with ``weights_only=True``. Checkpoints are pickles: nothing
    beyond tensors and plain containers is allowed to unpickle."""
    try:
        gelu = torch._C._nn.gelu  # pyright: ignore[reportAttributeAccessIssue]
        with torch.serialization.safe_globals([gelu]):
            state = torch.load(path, map_location="cpu", weights_only=True)
    except pickle.UnpicklingError as exc:
        raise EngineError(
            f"{path.name}: cannot load with weights_only=True. The checkpoint holds more "
            f"than tensors and is refused ({exc})."
        ) from exc
    except MemoryError as exc:
        raise EngineError(f"{path.name}: not enough memory to load the model") from exc
    except RuntimeError as exc:
        if "not enough memory" in str(exc) or "out of memory" in str(exc).lower():
            raise EngineError(
                f"{path.name}: not enough memory to load the model. Close other apps and retry."
            ) from exc
        raise EngineError(f"{path.name}: cannot load the checkpoint: {exc}") from exc
    except OSError as exc:
        raise EngineError(f"{path.name}: cannot read the checkpoint: {exc}") from exc
    if isinstance(state, dict):
        for key in ("state", "state_dict", "model_state_dict"):
            if key in state and isinstance(state[key], dict):
                state = state[key]
                break
        state.pop("_metadata", None)
    if not isinstance(state, dict):
        raise EngineError(f"{path.name}: checkpoint is not a state dict")
    return state


def config_stems(config: dict[str, Any]) -> tuple[str, ...]:
    training = config.get("training", {})
    target = training.get("target_instrument")
    if target:
        return (str(target),)
    return tuple(str(s) for s in training.get("instruments", ()))


class TorchLoadedModel:
    """A torch module on a device, run through the shared chunked runner."""

    def __init__(
        self,
        spec: ModelSpec,
        module: torch.nn.Module,
        device: torch.device,
        model_fn: ModelFn | None = None,
        stems: tuple[str, ...] | None = None,
    ) -> None:
        self.spec = spec
        self.module: torch.nn.Module | None = module
        self.device = device
        self.stems = stems or spec.stems
        self._fn: ModelFn = model_fn or (lambda x: module(x))
        self.vram_bytes = 0
        if device.type == "cuda":
            self.vram_bytes = sum(p.numel() * p.element_size() for p in module.parameters())

    def separate(
        self,
        mix: np.ndarray,
        settings: RunSettings,
        progress: ProgressFn | None = None,
        cancel: CancelToken | None = None,
        only: frozenset[str] | None = None,
    ) -> dict[str, np.ndarray]:
        if self.module is None:
            raise EngineError(f"{self.spec.id}: model was unloaded")
        return run_model(
            self._fn,
            mix,
            settings,
            stems=self.stems,
            device=self.device,
            progress=progress,
            cancel=cancel,
            only=only,
        )

    def unload(self) -> None:
        self.module = None
        self._fn = lambda x: x
        if self.device.type == "cuda":
            torch.cuda.empty_cache()


def finish_load(
    spec: ModelSpec,
    module: torch.nn.Module,
    state: dict[str, Any],
    stems: tuple[str, ...],
    model_fn_factory=None,
) -> TorchLoadedModel:
    """Load weights strictly, check the stem count against the catalog, move to the device."""
    # The catalog may rename stems, but it must name exactly as many as the model emits.
    if len(stems) != len(spec.stems):
        raise EngineError(
            f"{spec.id}: config emits {list(stems)} but the catalog names {list(spec.stems)}"
        )
    module.load_state_dict(state, strict=True)
    device = pick_device()
    module = module.to(device).eval()
    fn = model_fn_factory(module) if model_fn_factory else None
    return TorchLoadedModel(spec, module, device, fn, spec.stems)


def require_paths(spec: ModelSpec, store: ModelStore) -> tuple[Path, Path]:
    store.require(spec)
    config = store.config_path(spec)
    if config is None:
        raise EngineError(f"{spec.id}: this loader needs a config file")
    return store.checkpoint_path(spec), config
