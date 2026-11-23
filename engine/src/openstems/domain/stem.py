"""Tracks, stems, stem sets and the cache key."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

MANIFEST_NAME = "manifest.json"
MANIFEST_SCHEMA = 1


@dataclass(frozen=True)
class Track:
    """A source audio file, registered by path and content hash. Never modified."""

    path: str
    content_hash: str
    size: int

    @property
    def name(self) -> str:
        import os

        return os.path.splitext(os.path.basename(self.path))[0]


@dataclass(frozen=True)
class Stem:
    """One output audio file with its kind and provenance."""

    name: str
    file: str
    samples: int
    sample_rate: int
    source: str  # the signal reference it came from
    pass_id: str | None = None
    models: tuple[dict[str, Any], ...] = ()
    settings: dict[str, Any] | None = None
    peaks: str | None = None
    midi: str | None = None
    offset: int = 0  # samples trimmed from the start (0 unless silence trim is on)
    group: str = ""  # the larger stem this one is a part of, if any

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "file": self.file,
            "peaks": self.peaks,
            "midi": self.midi,
            "samples": self.samples,
            "sample_rate": self.sample_rate,
            "offset": self.offset,
            "source": self.source,
            "pass": self.pass_id,
            "models": list(self.models),
            "settings": self.settings,
            **({"group": self.group} if self.group else {}),
        }


@dataclass
class StemSet:
    """All stems of a job plus the manifest. Files are the source of truth."""

    directory: str
    manifest: dict[str, Any]
    stems: list[Stem] = field(default_factory=list)
    cached: bool = False


def cache_key(
    track_hash: str,
    recipe: dict[str, Any],
    settings: dict[str, Any],
    models: dict[str, str],
    output: dict[str, Any],
) -> str:
    """Track hash + recipe version and definition + settings (+ model hashes and output options).

    A job whose key already has a complete StemSet returns it without running.
    """
    payload = {
        "track": track_hash,
        "recipe": recipe,
        "settings": settings,
        "models": models,
        "output": output,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()
