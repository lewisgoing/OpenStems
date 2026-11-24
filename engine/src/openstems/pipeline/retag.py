"""Change the tempo and key of stems that are already written.

Detection is sometimes wrong: half or double the tempo, the relative major for a minor
key. The user's figures replace the detected ones everywhere they were used: the manifest,
file names made with ``{bpm}`` or ``{key}``, and the tempo FL Studio reads from a WAV.
The audio itself is never touched.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
from pathlib import Path
from typing import Any

from openstems.audio.write import set_tempo
from openstems.domain.errors import DomainError
from openstems.domain.naming import DEFAULT_TEMPLATE, render_name
from openstems.domain.stem import MANIFEST_NAME
from openstems.domain.tempo import notes_after_retag
from openstems.pipeline.run import read_manifest

MIXES_DIR = "Mixes"
_KEY = re.compile(r"^([A-Ga-g])([#b]?)(m?)$")
_FLATS = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#", "Cb": "B", "Fb": "E"}


def clean_bpm(value: Any) -> float | None:
    """A tempo as the manifest holds it, or None for "no tempo"."""
    if value is None:
        return None
    try:
        bpm = float(value)
    except (TypeError, ValueError):
        raise DomainError("the tempo must be a number") from None
    if not 20 <= bpm <= 999:
        raise DomainError("the tempo must be between 20 and 999 BPM")
    return float(round(bpm)) if abs(bpm - round(bpm)) < 0.005 else round(bpm, 2)


def clean_key(value: Any) -> str | None:
    """A key in the form detection writes it: ``C``, ``F#``, ``Am``. Flats are accepted
    and written as the sharp that sounds the same. None or "" is "no key"."""
    if value is None or not str(value).strip():
        return None
    match = _KEY.match(str(value).strip())
    if match is None:
        raise DomainError("the key must look like C, F#, Bb or Am")
    note = match.group(1).upper() + match.group(2)
    return _FLATS.get(note, note) + match.group(3)


def clean_changes(changes: dict[str, Any]) -> dict[str, Any]:
    """The ``bpm`` and ``key`` of a request, checked. Other fields are dropped."""
    out: dict[str, Any] = {}
    if "bpm" in changes:
        out["bpm"] = clean_bpm(changes["bpm"])
    if "key" in changes:
        out["key"] = clean_key(changes["key"])
    return out


def _tokens(manifest: dict[str, Any], analysis: dict[str, Any], directory: Path) -> dict[str, str]:
    source = manifest.get("source") or {}
    recipe = manifest.get("recipe") or {}
    return {
        "track": str(source.get("name") or directory.parent.name),
        "recipe": str(recipe.get("id") or ""),
        "bpm": str(analysis.get("bpm") or ""),
        "key": str(analysis.get("key") or ""),
    }


def _renames(
    manifest: dict[str, Any], old: dict[str, Any], new: dict[str, Any], directory: Path
) -> dict[str, str]:
    """Old file name to new, for the stems (and their MIDI) whose names hold the tempo or
    the key. A name is the template filled in, then perhaps " (2)" and the extension:
    whatever follows the filled-in template is kept."""
    template = str((manifest.get("options") or {}).get("template") or DEFAULT_TEMPLATE)
    if "{bpm}" not in template and "{key}" not in template:
        return {}
    before, after = _tokens(manifest, old, directory), _tokens(manifest, new, directory)
    moves: dict[str, str] = {}
    for stem in manifest.get("stems", []):
        was = render_name(template, stem=str(stem["name"]), **before)
        now = render_name(template, stem=str(stem["name"]), **after)
        for field in ("file", "midi"):
            name = stem.get(field)
            if name and str(name).startswith(was) and was != now:
                moves[str(name)] = now + str(name)[len(was) :]
    return moves


def set_analysis(directory: Path, changes: dict[str, Any]) -> dict[str, Any]:
    """Set the tempo and the key of the stem set in ``directory``.

    ``changes`` holds ``bpm`` and ``key``, either or both; a value of None means the song
    has none. Returns the new manifest. What detection found is kept under
    ``analysis.detected`` the first time something is changed.
    """
    manifest = read_manifest(directory)
    if manifest is None:
        raise DomainError("that folder does not hold a set of stems")
    old = dict(manifest.get("analysis") or {})
    new = {**old, **clean_changes(changes)}
    if new.get("bpm") == old.get("bpm") and new.get("key") == old.get("key"):
        return manifest
    new.setdefault("detected", {"bpm": old.get("bpm"), "key": old.get("key")})

    moves = _renames(manifest, old, new, directory)
    taken = {name.lower() for name in os.listdir(directory)} - {name.lower() for name in moves}
    targets = [name.lower() for name in moves.values()]
    if len(set(targets)) != len(targets) or taken & set(targets):
        raise DomainError("a file with the new name is already in the stem folder")
    for name in moves:
        if not (directory / name).is_file():
            raise DomainError(f"{name} is missing from the stem folder")

    # Every step is undone if a later one fails, so the folder is never left half changed:
    # on Windows a stem that is open in another program (a DAW, the app's own player) can
    # be neither renamed nor written to.
    marked: list[Path] = []
    moved: list[tuple[Path, Path]] = []
    options = manifest.get("options") or {}
    try:
        if options.get("tempo_sync") and new.get("bpm") != old.get("bpm"):
            for file in _marked_files(manifest, directory):
                set_tempo(file, new.get("bpm"))
                marked.append(file)
        for was, now in moves.items():
            os.replace(directory / was, directory / now)
            moved.append((directory / was, directory / now))
        updated = json.loads(json.dumps(manifest))
        for stem in updated.get("stems", []):
            for field in ("file", "midi"):
                if stem.get(field) in moves:
                    stem[field] = moves[stem[field]]
        updated["analysis"] = new
        updated["notes"] = notes_after_retag(list(updated.get("notes") or []), new.get("bpm"))
        tmp = directory / (MANIFEST_NAME + ".tmp")
        tmp.write_text(json.dumps(updated, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, directory / MANIFEST_NAME)
    except OSError as exc:
        for was, now in reversed(moved):
            with contextlib.suppress(OSError):
                os.replace(now, was)
        # The renames are undone first, so each file is at its old path again.
        for file in reversed(marked):
            with contextlib.suppress(OSError):
                set_tempo(file, old.get("bpm"))
        with contextlib.suppress(OSError):
            (directory / (MANIFEST_NAME + ".tmp")).unlink(missing_ok=True)
        which = Path(str(exc.filename)).name if exc.filename else str(exc)
        raise DomainError(
            "a stem is open in another program, so nothing was changed. Close it there "
            f"and try again ({which})."
        ) from exc
    return updated


def _marked_files(manifest: dict[str, Any], directory: Path) -> list[Path]:
    """The WAV files whose tempo mark follows the song's: its stems and its mixes."""
    files = [directory / str(stem["file"]) for stem in manifest.get("stems", [])]
    mixes = directory / MIXES_DIR
    if mixes.is_dir():
        files += sorted(p for p in mixes.iterdir() if p.is_file())
    return [f for f in files if f.suffix.lower() == ".wav" and f.is_file()]
