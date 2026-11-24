"""Expanding dropped files and folders into the media files to process."""

from __future__ import annotations

from pathlib import Path

# The app drags a song's original file out only in these formats (`DRAGGABLE` in
# app/electron/main.ts): change both together.
AUDIO_SUFFIXES = {
    ".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".aif", ".aiff", ".wma",
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".wv", ".ape", ".alac", ".caf",
}  # fmt: skip


def is_media(path: Path) -> bool:
    return path.suffix.lower() in AUDIO_SUFFIXES


def expand_inputs(paths: list[Path]) -> list[Path]:
    """Files as given; folders expand to the media files inside them (recursively)."""
    out: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        if path.is_dir():
            found = sorted(p for p in path.rglob("*") if p.is_file() and is_media(p))
        else:
            found = [path]
        for item in found:
            key = str(item).lower()
            # Skip our own outputs if a results folder is dropped back in by mistake.
            if key not in seen and ".peaks" not in item.parts:
                seen.add(key)
                out.append(item)
    return out
