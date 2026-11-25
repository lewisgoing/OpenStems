"""Give a song that is already separated another name.

A song's name is where its stems are and what they are called: the folder
``<output>/<name>/`` and, through the naming template's ``{track}``, every stem and MIDI
file in it. A rename changes all of that, for every recipe the song was separated with, so
the name on the screen is the name on the disk. The audio is never touched, and the song's
own file keeps its name.

Mixes and clips made from the stems move with the folder and keep the file names they have:
a clip given to a DAW is not renamed under it (ADR 0028).
"""

from __future__ import annotations

import contextlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from openstems.domain.errors import DomainError
from openstems.domain.naming import DEFAULT_TEMPLATE, render_name, safe_component
from openstems.domain.stem import MANIFEST_NAME
from openstems.pipeline.retag import tokens_of
from openstems.pipeline.run import read_manifest


@dataclass(frozen=True)
class Moved:
    """One stem folder of a renamed song: where it was, where it is, and its manifest now."""

    was: Path
    now: Path
    manifest: dict[str, Any]


def _file_moves(manifest: dict[str, Any], directory: Path, name: str) -> dict[str, str]:
    """Old file name to new, for the stems (and their MIDI) whose names hold the song's.
    A name is the template filled in, then perhaps " (2)" and the extension: whatever
    follows the filled-in template is kept."""
    template = str((manifest.get("options") or {}).get("template") or DEFAULT_TEMPLATE)
    if "{track}" not in template:
        return {}
    before = tokens_of(manifest, manifest.get("analysis") or {}, directory)
    after = {**before, "track": name}
    moves: dict[str, str] = {}
    for stem in manifest.get("stems", []):
        was = render_name(template, stem=str(stem["name"]), **before)
        now = render_name(template, stem=str(stem["name"]), **after)
        for field in ("file", "midi"):
            file = stem.get(field)
            if file and str(file).startswith(was) and was != now:
                moves[str(file)] = now + str(file)[len(was) :]
    return moves


def _renamed(manifest: dict[str, Any], moves: dict[str, str], name: str) -> dict[str, Any]:
    updated = json.loads(json.dumps(manifest))
    for stem in updated.get("stems", []):
        for field in ("file", "midi"):
            if stem.get(field) in moves:
                stem[field] = moves[stem[field]]
    updated.setdefault("source", {})["name"] = name
    return updated


def _write_manifest(directory: Path, manifest: dict[str, Any]) -> None:
    tmp = directory / (MANIFEST_NAME + ".tmp")
    try:
        tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, directory / MANIFEST_NAME)
    except OSError:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise


def _same_folder(one: Path, other: Path) -> bool:
    try:
        return os.path.samefile(one, other)
    except OSError:
        return False


def rename_song(directory: Path, name: str) -> list[Moved]:
    """Name the song whose stems are in ``directory`` ``name``, on the disk.

    ``directory`` is one stem folder, ``<output>/<song>/<recipe>``. The song's folder is
    renamed, with every stem folder in it: their stems and MIDI files where the naming
    template holds ``{track}``, and the name in each manifest. Returns every stem folder of
    the song, before and after. Nothing is written over: a folder or a file that already
    has the new name stops the rename before anything is changed, and a step that fails
    undoes the ones before it.
    """
    if read_manifest(directory) is None:
        raise DomainError("that folder does not hold a set of stems")
    old_folder = directory.parent
    new_folder = old_folder.parent / safe_component(name)
    try:
        folders = sorted(p for p in old_folder.iterdir() if p.is_dir())
    except OSError as exc:
        raise DomainError(f"cannot read the song's folder: {exc}") from exc
    sets = [(folder, manifest) for folder in folders if (manifest := read_manifest(folder))]

    move_folder = new_folder.name != old_folder.name
    if move_folder and new_folder.exists() and not _same_folder(old_folder, new_folder):
        raise DomainError(f'there is already a song called "{name}" in the output folder')

    plans: list[tuple[Path, dict[str, Any], dict[str, str]]] = []
    for folder, manifest in sets:
        moves = _file_moves(manifest, folder, name)
        # A stem that is gone from its folder cannot be renamed: its entry still is.
        there = {was: now for was, now in moves.items() if (folder / was).is_file()}
        taken = {f.lower() for f in os.listdir(folder)} - {was.lower() for was in there}
        targets = [now.lower() for now in there.values()]
        if len(set(targets)) != len(targets) or taken & set(targets):
            raise DomainError("a file with the new name is already in the stem folder")
        plans.append((folder, manifest, moves))

    unchanged = all((m.get("source") or {}).get("name") == name for _, m, _ in plans)
    if not move_folder and unchanged and not any(moves for _, _, moves in plans):
        return [Moved(folder, folder, manifest) for folder, manifest, _ in plans]

    # The folder goes first: on Windows it cannot move while a program holds one of its
    # files open (a DAW, a player), and then nothing has been changed yet. Every step
    # after it is undone if a later one fails.
    moved_folder = False
    files: list[tuple[Path, Path]] = []
    written: list[tuple[Path, dict[str, Any]]] = []
    out: list[Moved] = []
    try:
        if move_folder:
            os.rename(old_folder, new_folder)
            moved_folder = True
        for folder, manifest, moves in plans:
            here = new_folder / folder.name
            for was, now in moves.items():
                if (here / was).is_file():
                    os.replace(here / was, here / now)
                    files.append((here / was, here / now))
            updated = _renamed(manifest, moves, name)
            _write_manifest(here, updated)
            written.append((here, manifest))
            out.append(Moved(folder, here, updated))
    except OSError as exc:
        for here, manifest in reversed(written):
            with contextlib.suppress(OSError):
                _write_manifest(here, manifest)
        for was, now in reversed(files):
            with contextlib.suppress(OSError):
                os.replace(now, was)
        if moved_folder:
            with contextlib.suppress(OSError):
                os.rename(new_folder, old_folder)
        if isinstance(exc, PermissionError):
            raise DomainError(
                "a file of this song is open in another program, so nothing was renamed. "
                "Close it there and try again."
            ) from exc
        raise DomainError(f"the song could not be renamed: {exc.strerror or exc}") from exc
    return out
