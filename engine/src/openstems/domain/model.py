"""Model catalog entries. Pure data: no torch, no I/O."""

from __future__ import annotations

from dataclasses import dataclass

from openstems.domain.errors import DomainError

ARCHITECTURES = ("bs_roformer", "mel_band_roformer", "mdx23c", "fake")


@dataclass(frozen=True)
class ModelFile:
    """One downloadable file of a model."""

    kind: str  # "checkpoint" or "config"
    name: str
    url: str
    sha256: str
    size: int

    def __post_init__(self) -> None:
        if self.kind not in ("checkpoint", "config"):
            raise DomainError(f"unknown model file kind: {self.kind!r}")
        digest = self.sha256.lower()
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise DomainError(f"{self.name}: sha256 must be 64 hex characters")
        if self.size <= 0:
            raise DomainError(f"{self.name}: size must be positive")
        if self.url and not self.url.startswith("https://"):
            raise DomainError(f"{self.name}: url must be https")


@dataclass(frozen=True)
class ModelSpec:
    """A catalog entry: architecture, files, license and the stems the model emits."""

    id: str
    name: str
    architecture: str
    loader: str
    files: tuple[ModelFile, ...]
    stems: tuple[str, ...]
    use_cases: tuple[str, ...] = ()
    license: str = "unrecorded"
    variation: str | None = None
    sample_rate: int = 44100
    chunk_size: int = 352800
    num_overlap: int = 2
    seed: bool = False
    experimental: bool = False
    custom: bool = False
    notes: str = ""
    # Peak GPU memory of one run at batch 1 with half precision, in GB, when it was
    # measured (docs/benchmarks.md). None: `domain.memory` estimates it.
    memory_gb: float | None = None

    def __post_init__(self) -> None:
        if self.architecture not in ARCHITECTURES:
            raise DomainError(f"{self.id}: unknown architecture {self.architecture!r}")
        if not self.stems:
            raise DomainError(f"{self.id}: a model must emit at least one stem")
        if len(set(self.stems)) != len(self.stems):
            raise DomainError(f"{self.id}: duplicate stem names")
        kinds = [f.kind for f in self.files]
        if kinds.count("checkpoint") != 1:
            raise DomainError(f"{self.id}: exactly one checkpoint file is required")
        if kinds.count("config") > 1:
            raise DomainError(f"{self.id}: at most one config file")
        if self.chunk_size <= 0 or self.num_overlap <= 0:
            raise DomainError(f"{self.id}: chunk_size and num_overlap must be positive")
        if self.memory_gb is not None and self.memory_gb <= 0:
            raise DomainError(f"{self.id}: memory_gb must be positive")

    @property
    def checkpoint(self) -> ModelFile:
        return next(f for f in self.files if f.kind == "checkpoint")

    @property
    def config(self) -> ModelFile | None:
        return next((f for f in self.files if f.kind == "config"), None)

    @property
    def total_bytes(self) -> int:
        return sum(f.size for f in self.files)
