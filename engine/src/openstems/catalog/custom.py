"""Import a local checkpoint as a custom model."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import yaml

from openstems.catalog.catalog import CUSTOM_DIR, CUSTOM_MANIFEST, builtin_models, model_from_dict
from openstems.catalog.store import ModelStore, sha256_file
from openstems.domain.errors import DomainError
from openstems.domain.model import ModelSpec

PICKLE_WARNING = (
    "Checkpoints are pickles: a malicious file can run code when it is loaded. OpenStems "
    "loads with weights_only=True, which blocks that, but only import checkpoints from a "
    "source you trust."
)
IMPORTABLE = ("bs_roformer", "mel_band_roformer", "mdx23c")
_LOADERS = {
    "bs_roformer": "bs-roformer-infer",
    "mel_band_roformer": "melband-roformer-infer",
    "mdx23c": "mdxnet-infer",
}


class _TupleLoader(yaml.SafeLoader):
    pass


_TupleLoader.add_constructor(
    "tag:yaml.org,2002:python/tuple",
    lambda loader, node: loader.construct_sequence(node),  # pyright: ignore[reportArgumentType]
)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "model"


def read_config(config: Path, architecture: str) -> tuple[tuple[str, ...], int, int]:
    """Stems, hop-aligned chunk size and overlap from a training config YAML."""
    try:
        data = yaml.load(config.read_text("utf-8"), Loader=_TupleLoader)
    except (OSError, yaml.YAMLError) as exc:
        raise DomainError(f"cannot read config {config.name}: {exc}") from exc
    if not isinstance(data, dict) or "model" not in data:
        raise DomainError(f"{config.name} does not look like a model config (no 'model' section)")
    training = data.get("training") or {}
    target = training.get("target_instrument")
    stems = [target] if target else list(training.get("instruments") or [])
    if not stems:
        raise DomainError(f"{config.name} names no instruments under 'training'")
    audio = data.get("audio") or {}
    inference = data.get("inference") or {}
    chunk = int(inference.get("chunk_size") or audio.get("chunk_size") or 352800)
    if architecture == "mdx23c":
        hop = int(audio.get("hop_length") or 1)
    else:
        hop = int((data.get("model") or {}).get("stft_hop_length") or 1)
    names: list[str] = []
    for stem in stems:
        name = re.sub(r"[^A-Za-z0-9 _-]+", "", str(stem)).strip().lower() or "stem"
        while name in names:
            name += "_"
        names.append(name)
    return tuple(names), chunk - chunk % max(hop, 1), int(inference.get("num_overlap") or 2)


def import_model(
    models_dir: Path,
    checkpoint: Path,
    config: Path,
    architecture: str,
    model_id: str | None = None,
    name: str | None = None,
) -> ModelSpec:
    """Copy a checkpoint and its config into ``{models_dir}/custom/<id>/`` and register it.

    The files are hashed on import, so the model is verified like any catalog model.
    """
    if architecture not in IMPORTABLE:
        raise DomainError(f"architecture must be one of {IMPORTABLE}")
    if not checkpoint.is_file():
        raise DomainError(f"no such checkpoint: {checkpoint}")
    if not config.is_file():
        raise DomainError(f"no such config: {config}")
    mid = _slug(model_id or checkpoint.stem)
    if not mid.startswith("custom-"):
        mid = f"custom-{mid}"
    if mid in builtin_models():
        raise DomainError(f"{mid!r} is already a catalog model")
    stems, chunk, overlap = read_config(config, architecture)

    folder = models_dir / CUSTOM_DIR / mid
    if folder.exists():
        raise DomainError(f"a custom model named {mid!r} already exists")
    folder.mkdir(parents=True)
    try:
        files = []
        for kind, source in (("checkpoint", checkpoint), ("config", config)):
            target = folder / source.name
            shutil.copy2(source, target)
            files.append(
                {
                    "kind": kind,
                    "name": source.name,
                    "sha256": sha256_file(target),
                    "size": target.stat().st_size,
                }
            )
        raw = {
            "name": name or checkpoint.stem,
            "architecture": architecture,
            "loader": _LOADERS[architecture],
            "license": "unrecorded (imported by the user)",
            "stems": list(stems),
            "chunk_size": chunk,
            "num_overlap": overlap,
            "notes": f"Imported from {checkpoint}",
            "files": files,
        }
        spec = model_from_dict(mid, raw, custom=True)
        (folder / CUSTOM_MANIFEST).write_text(_to_toml(raw), encoding="utf-8")
        problems = ModelStore(models_dir).verify(spec)
        if problems:
            raise DomainError("; ".join(problems))
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return spec


def _to_toml(raw: dict) -> str:
    lines = []
    for key, value in raw.items():
        if key != "files":
            lines.append(f"{key} = {json.dumps(value, ensure_ascii=False)}")
    for file in raw["files"]:
        lines.append("")
        lines.append("[[files]]")
        lines += [f"{k} = {json.dumps(v, ensure_ascii=False)}" for k, v in file.items()]
    return "\n".join(lines) + "\n"
