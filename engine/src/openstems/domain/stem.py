"""Tracks, stems, stem sets and the cache key."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from openstems.domain.naming import MAX_COMPONENT

MANIFEST_NAME = "manifest.json"
# The fields of a stem in the manifest that name a file of its own, beside it: the audio,
# its MIDI and its notes. What renames a stem, or replaces a stem set, goes by these.
STEM_FILES = ("file", "midi", "notes")
MANIFEST_SCHEMA = 1


@dataclass(frozen=True)
class Track:
    """A source audio file, registered by path and content hash. Never modified."""

    path: str
    content_hash: str
    size: int
    # A part of the song separated alone, named as a clip of it is ("bars 9-16"). Its stems
    # are a song of their own, "<track> (<part>)", so they never mix with the whole song's.
    part: str = ""
    # The name the user gave the song, in place of its file's. The file keeps its own.
    title: str = ""

    @property
    def name(self) -> str:
        import os

        name = self.title or os.path.splitext(os.path.basename(self.path))[0]
        if not self.part:
            return name
        # A name too long for a folder is cut in the song's name, never in the part's, or
        # two parts of the song would share a folder.
        tail = f" ({self.part})"
        return name[: max(0, MAX_COMPONENT - len(tail))].rstrip() + tail


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
    notes: str | None = None  # the notes file (stem to MIDI), when the stem was read
    offset: int = 0  # samples trimmed from the start (0 unless silence trim is on)
    group: str = ""  # the larger stem this one is a part of, if any
    # The largest sample of the stem as it was separated, before normalize. None in a
    # manifest from before it was measured. It decides whether the stem is empty.
    peak: float | None = None
    # The user's own choice for the app's lists: True leaves the stem out, False keeps it
    # in though it is empty, None lets the app decide (`pipeline/levels.py`, `set_hidden`).
    hidden: bool | None = None

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
            **({"notes": self.notes} if self.notes else {}),
            **({"group": self.group} if self.group else {}),
            **({"peak": self.peak} if self.peak is not None else {}),
            **({"hidden": self.hidden} if self.hidden is not None else {}),
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
