"""Quality presets: named settings resolved per architecture."""

from __future__ import annotations

from dataclasses import asdict, dataclass

from openstems.domain.errors import DomainError
from openstems.domain.model import ModelSpec

PRESET_NAMES = ("fast", "balanced", "best")


@dataclass(frozen=True)
class QualityPreset:
    """Named settings. ``chunk_size`` of ``None`` means the model's own chunk size."""

    name: str
    num_overlap: int
    batch_size: int
    tta: bool
    precision: str = "fp16"  # "fp16" (autocast) or "fp32"
    chunk_size: int | None = None


@dataclass(frozen=True)
class RunSettings:
    """Fully resolved settings for one model run. Part of the cache key."""

    chunk_size: int
    num_overlap: int
    batch_size: int
    tta: bool
    precision: str

    def as_dict(self) -> dict[str, object]:
        return asdict(self)

    def key_dict(self) -> dict[str, object]:
        """Settings that change the audio. Batch size does not, so it stays out of the key."""
        d = asdict(self)
        d.pop("batch_size")
        return d


# Overlap is the number of chunk passes over each sample (MSST's num_overlap).
# Batch sizes are starting points; the runner halves them on out-of-memory errors.
# On the 5070 Ti the RoFormers gain under 15% from batching while VRAM doubles per step
# (docs/benchmarks.md), so they run one chunk at a time.
_PRESETS: dict[str, dict[str, QualityPreset]] = {
    "bs_roformer": {
        "fast": QualityPreset("fast", num_overlap=2, batch_size=1, tta=False),
        "balanced": QualityPreset("balanced", num_overlap=4, batch_size=1, tta=False),
        "best": QualityPreset("best", num_overlap=8, batch_size=1, tta=True),
    },
    "mel_band_roformer": {
        "fast": QualityPreset("fast", num_overlap=2, batch_size=1, tta=False),
        "balanced": QualityPreset("balanced", num_overlap=4, batch_size=1, tta=False),
        "best": QualityPreset("best", num_overlap=8, batch_size=1, tta=True),
    },
    "mdx23c": {
        "fast": QualityPreset("fast", num_overlap=2, batch_size=4, tta=False),
        "balanced": QualityPreset("balanced", num_overlap=4, batch_size=4, tta=False),
        "best": QualityPreset("best", num_overlap=8, batch_size=4, tta=True),
    },
    "fake": {
        "fast": QualityPreset("fast", num_overlap=2, batch_size=4, tta=False, precision="fp32"),
        "balanced": QualityPreset(
            "balanced", num_overlap=4, batch_size=4, tta=False, precision="fp32"
        ),
        "best": QualityPreset("best", num_overlap=8, batch_size=4, tta=True, precision="fp32"),
    },
}


def get_preset(name: str, architecture: str) -> QualityPreset:
    key = name.lower()
    if key not in PRESET_NAMES:
        raise DomainError(f"unknown quality preset {name!r}; choose from {PRESET_NAMES}")
    try:
        return _PRESETS[architecture][key]
    except KeyError as exc:
        raise DomainError(f"no presets for architecture {architecture!r}") from exc


def resolve_settings(preset_name: str, model: ModelSpec) -> RunSettings:
    """Resolve a preset against one model: the model supplies the chunk size."""
    preset = get_preset(preset_name, model.architecture)
    return RunSettings(
        chunk_size=preset.chunk_size or model.chunk_size,
        num_overlap=preset.num_overlap,
        batch_size=preset.batch_size,
        tta=preset.tta,
        precision=preset.precision,
    )
