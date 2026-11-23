"""Load the model catalog from models.toml (plus custom models in the models folder)."""

from __future__ import annotations

import tomllib
from collections.abc import Iterator, Mapping
from importlib import resources
from pathlib import Path
from typing import Any

from openstems.domain.errors import DomainError
from openstems.domain.model import ModelFile, ModelSpec

CUSTOM_DIR = "custom"
CUSTOM_MANIFEST = "model.toml"


def model_from_dict(model_id: str, raw: Mapping[str, Any], *, custom: bool = False) -> ModelSpec:
    try:
        files = tuple(
            ModelFile(
                kind=f["kind"],
                name=f["name"],
                url=f.get("url", ""),
                sha256=f["sha256"],
                size=int(f["size"]),
            )
            for f in raw["files"]
        )
        return ModelSpec(
            id=model_id,
            name=raw.get("name", model_id),
            architecture=raw["architecture"],
            loader=raw.get("loader", raw["architecture"]),
            files=files,
            stems=tuple(raw["stems"]),
            use_cases=tuple(raw.get("use_cases", ())),
            license=raw.get("license", "unrecorded"),
            variation=raw.get("variation"),
            sample_rate=int(raw.get("sample_rate", 44100)),
            chunk_size=int(raw.get("chunk_size", 352800)),
            num_overlap=int(raw.get("num_overlap", 2)),
            seed=bool(raw.get("seed", False)),
            experimental=bool(raw.get("experimental", False)),
            custom=custom,
            notes=raw.get("notes", ""),
        )
    except KeyError as exc:
        raise DomainError(f"model {model_id!r} is missing field {exc.args[0]!r}") from exc


class Catalog:
    """Model specs by id."""

    def __init__(self, models: Mapping[str, ModelSpec]) -> None:
        self._models = dict(models)

    def __iter__(self) -> Iterator[ModelSpec]:
        return iter(self._models.values())

    def __len__(self) -> int:
        return len(self._models)

    def __contains__(self, model_id: object) -> bool:
        return model_id in self._models

    def get(self, model_id: str) -> ModelSpec:
        try:
            return self._models[model_id]
        except KeyError:
            raise DomainError(f"unknown model {model_id!r}") from None

    def ids(self) -> list[str]:
        return list(self._models)

    def seed(self) -> list[ModelSpec]:
        return [m for m in self if m.seed]

    def stems_of(self, model_id: str) -> tuple[str, ...]:
        return self.get(model_id).stems

    def with_models(self, extra: Mapping[str, ModelSpec]) -> Catalog:
        merged = dict(self._models)
        merged.update(extra)
        return Catalog(merged)


def parse_catalog(text: str) -> dict[str, ModelSpec]:
    data = tomllib.loads(text)
    return {mid: model_from_dict(mid, raw) for mid, raw in data.get("models", {}).items()}


def builtin_models() -> dict[str, ModelSpec]:
    text = resources.files("openstems.catalog").joinpath("models.toml").read_text("utf-8")
    return parse_catalog(text)


def custom_models(models_dir: Path) -> dict[str, ModelSpec]:
    """Models imported by the user: ``{models_dir}/custom/<id>/model.toml``."""
    found: dict[str, ModelSpec] = {}
    root = models_dir / CUSTOM_DIR
    if not root.is_dir():
        return found
    for manifest in sorted(root.glob(f"*/{CUSTOM_MANIFEST}")):
        try:
            raw = tomllib.loads(manifest.read_text("utf-8"))
            spec = model_from_dict(manifest.parent.name, raw, custom=True)
        except (DomainError, tomllib.TOMLDecodeError, OSError):
            continue
        found[spec.id] = spec
    return found


def load_catalog(models_dir: Path | None = None) -> Catalog:
    models = builtin_models()
    if models_dir is not None:
        for mid, spec in custom_models(models_dir).items():
            models.setdefault(mid, spec)
    return Catalog(models)
