"""Change the tempo, key and bar 1 of stems that are already written.

Detection is sometimes wrong: half or double the tempo, the relative major for a minor
key, bar 1 on the wrong beat. The user's figures replace the detected ones everywhere they
were used: the manifest, file names made with ``{bpm}`` or ``{key}``, and the tempo FL
Studio reads from a WAV. Bar 1 is only in the manifest. The audio itself is never touched.
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
from openstems.domain.grid import clean_downbeat
from openstems.domain.naming import DEFAULT_TEMPLATE, render_name
from openstems.domain.stem import MANIFEST_NAME, STEM_FILES
from openstems.domain.tempo import notes_after_retag
from openstems.pipeline.run import read_manifest

MIXES_DIR = "Mixes"
# What the user may set by hand, in the manifest's ``analysis``.
FIELDS = ("bpm", "key", "downbeat")
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
    """The ``bpm``, ``key`` and ``downbeat`` of a request, checked. Other fields are
    dropped."""
    out: dict[str, Any] = {}
    if "bpm" in changes:
        out["bpm"] = clean_bpm(changes["bpm"])
    if "key" in changes:
        out["key"] = clean_key(changes["key"])
    if "downbeat" in changes:
        out["downbeat"] = clean_downbeat(changes["downbeat"])
    return out


def tokens_of(
    manifest: dict[str, Any], analysis: dict[str, Any], directory: Path
) -> dict[str, str]:
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
    before, after = tokens_of(manifest, old, directory), tokens_of(manifest, new, directory)
    moves: dict[str, str] = {}
    for stem in manifest.get("stems", []):
        was = render_name(template, stem=str(stem["name"]), **before)
        now = render_name(template, stem=str(stem["name"]), **after)
        for field in STEM_FILES:
            name = stem.get(field)
            if name and str(name).startswith(was) and was != now:
                moves[str(name)] = now + str(name)[len(was) :]
    return moves


def set_analysis(directory: Path, changes: dict[str, Any]) -> dict[str, Any]:
    """Set the tempo, the key and bar 1 of the stem set in ``directory``.

    ``changes`` holds any of ``bpm``, ``key`` and ``downbeat`` (where bar 1 starts, in
    seconds into the song); a value of None means the song has none. Returns the new
    manifest. What detection found is kept under ``analysis.detected`` the first time
    something is changed. Bar 1 alone changes the manifest and nothing else.
    """
    manifest = read_manifest(directory)
    if manifest is None:
        raise DomainError("that folder does not hold a set of stems")
    old = dict(manifest.get("analysis") or {})
    new = {**old, **clean_changes(changes)}
    if all(new.get(name) == old.get(name) for name in FIELDS):
        return manifest
    new.setdefault("detected", {name: old.get(name) for name in FIELDS})
    # What a write of notes that was cut short left is cleared first: once the files have
    # other names it would not be found.
    from openstems.pipeline.notes import recover, why_refused

    recover(directory, manifest)

    moves = _renames(manifest, old, new, directory)
    taken = {name.lower() for name in os.listdir(directory)} - {name.lower() for name in moves}
    targets = [name.lower() for name in moves.values()]
    if len(set(targets)) != len(targets) or taken & set(targets):
        raise DomainError("a file with the new name is already in the stem folder")
    # A stem that is gone stops the change. A notes or MIDI file the user took away does
    # not: its entry in the manifest takes the new name, and there is nothing to move.
    audio = {str(stem["file"]) for stem in manifest.get("stems", [])}
    there = {was: now for was, now in moves.items() if (directory / was).is_file()}
    for name in moves:
        if name in audio and name not in there:
            raise DomainError(f"{name} is missing from the stem folder")

    # Every step is undone if a later one fails, so the folder is never left half changed:
    # on Windows a stem that is open in another program (a DAW, the app's own player) can
    # be neither renamed nor written to.
    marked: list[Path] = []
    moved: list[tuple[Path, Path]] = []
    rewritten: list[tuple[Path, bytes]] = []
    options = manifest.get("options") or {}
    try:
        if options.get("tempo_sync") and new.get("bpm") != old.get("bpm"):
            for file in _marked_files(manifest, directory):
                set_tempo(file, new.get("bpm"))
                marked.append(file)
        for was, now in there.items():
            os.replace(directory / was, directory / now)
            moved.append((directory / was, directory / now))
        updated = json.loads(json.dumps(manifest))
        for stem in updated.get("stems", []):
            for field in STEM_FILES:
                if stem.get(field) in moves:
                    stem[field] = moves[stem[field]]
        if any(new.get(name) != old.get(name) for name in ("bpm", "key")):
            rewrite_midi(directory, updated, new, rewritten, on_disk=manifest)
        updated["analysis"] = new
        updated["notes"] = notes_after_retag(list(updated.get("notes") or []), new.get("bpm"))
        tmp = directory / (MANIFEST_NAME + ".tmp")
        tmp.write_text(json.dumps(updated, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, directory / MANIFEST_NAME)
    except Exception as exc:
        undo_midi(rewritten)
        for was, now in reversed(moved):
            with contextlib.suppress(OSError):
                os.replace(now, was)
        # The renames are undone first, so each file is at its old path again.
        for file in reversed(marked):
            with contextlib.suppress(OSError):
                set_tempo(file, old.get("bpm"))
        with contextlib.suppress(OSError):
            (directory / (MANIFEST_NAME + ".tmp")).unlink(missing_ok=True)
        if not isinstance(exc, OSError):
            raise  # not a file in the way: a fault, with the folder as it was
        which = Path(str(exc.filename)).name if exc.filename else str(exc)
        refused = why_refused(exc, "nothing was changed", which)
        if refused is None:
            refused = f"nothing was changed: {exc.strerror or exc} ({which})"
        raise DomainError(refused) from exc
    return updated


def rewrite_midi(
    directory: Path,
    manifest: dict[str, Any],
    analysis: dict[str, Any],
    rewritten: list[tuple[Path, bytes]],
    written_as: str | None = None,
    on_disk: dict[str, Any] | None = None,
) -> None:
    """Write each stem's MIDI file again from its notes file, on the manifest's song name
    and the given tempo and key: a MIDI file places its notes in beats, so the old one would
    hold them at the old tempo's, and it names its track after the song. ``rewritten``
    collects each file with what it held, for `undo_midi`.

    A stem whose notes file is gone or damaged keeps its MIDI file as it is. A notes file
    that is there and cannot be read now (open in another program) raises before anything
    is written, as a stem that is open does: the change is undone, where carrying on would
    leave that MIDI file on the old tempo with nothing said.

    A MIDI file somebody changed since the app wrote it is theirs, and stays as it is: the
    manifest keeps the sha256 of what the app wrote (``midi_hash``, set here anew). Of a
    file from before that was kept, a new tempo cannot tell, and makes it again.
    ``written_as`` is the song's name when the files were written. Given it, such a file is
    made again only if it still holds, to the byte, what the app makes of its notes file
    under that name: a rename wants only the new name inside the file.

    ``on_disk`` is the manifest as the folder holds it while this runs: the caller writes
    the new one only afterwards. Before a file is touched it is written once more, with
    the hash each file is about to have beside the one it has (``midi_hash``,
    ``midi_was``). Were the process to end between a file and the manifest that follows
    it, the app would otherwise take its own MIDI file for one somebody changed. What the
    manifest held goes into ``rewritten`` too, first, so `undo_midi` puts it back last.
    """
    from openstems.pipeline.notes import (
        changed,
        digest,
        midi_from_sidecar,
        read_only,
        track_name,
    )

    title = str((manifest.get("source") or {}).get("name") or "")
    plan: list[tuple[dict[str, Any], Path, bytes, bytes]] = []
    for stem in manifest.get("stems", []):
        if not (stem.get("midi") and stem.get("notes")):
            continue
        target = directory / str(stem["midi"])
        try:
            raw = (directory / str(stem["notes"])).read_bytes()
        except FileNotFoundError:
            continue

        def made(name: str, raw: bytes = raw, stem: dict[str, Any] = stem) -> bytes | None:
            return midi_from_sidecar(
                json.loads(raw.decode("utf-8")),
                name=track_name(name, str(stem["name"])),
                bpm=analysis.get("bpm"),
                key=analysis.get("key"),
            )

        try:
            data = made(title)
            untouched = made(written_as) if written_as is not None else None
        except Exception:  # whatever is wrong with a notes file, the MIDI file is not at fault
            continue
        if data is None or not target.is_file():
            continue
        # A file marked read-only is left as it is, and so is somebody's. One that is there
        # and cannot be read raises (`changed`): whose it is cannot be told.
        if read_only(target) or changed(directory, stem):
            continue
        held = target.read_bytes()
        if written_as is not None and not stem.get("midi_hash") and held != untouched:
            continue
        plan.append((stem, target, held, data))
    if not plan:
        return
    if on_disk is not None:
        saying = json.loads(json.dumps(on_disk))  # the caller's own is left as it is
        entries = {str(entry.get("name")): entry for entry in saying.get("stems", [])}
        for stem, _, held, data in plan:
            entry = entries.get(str(stem["name"]))
            if entry is not None:
                entry["midi_hash"], entry["midi_was"] = digest(data), digest(held)
        target = directory / MANIFEST_NAME
        rewritten.append((target, target.read_bytes()))
        tmp = directory / (MANIFEST_NAME + ".tmp")
        tmp.write_text(json.dumps(saying, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
    for stem, target, held, data in plan:
        stem["midi_hash"] = digest(data)
        stem.pop("midi_was", None)
        # What it held is kept before it is touched, and it is replaced whole: a write that
        # fails halfway leaves the old file, and a reader never sees half of the new one.
        rewritten.append((target, held))
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, target)


def undo_midi(rewritten: list[tuple[Path, bytes]]) -> None:
    """Put back what `rewrite_midi` replaced, the last file first, each one whole. The
    manifest it wrote before the MIDI files comes last, and only if every one of them is
    back: failing that, it stays as the one that knows a file's new bytes and its old."""
    back = True
    for file, data in reversed(rewritten):
        tmp = file.with_name(file.name + ".tmp")
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        if file.name == MANIFEST_NAME and not back:
            continue
        try:
            if file.read_bytes() != data:
                tmp.write_bytes(data)
                os.replace(tmp, file)
        except OSError:
            back = False
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)


def _marked_files(manifest: dict[str, Any], directory: Path) -> list[Path]:
    """The WAV files whose tempo mark follows the song's: its stems and its mixes."""
    files = [directory / str(stem["file"]) for stem in manifest.get("stems", [])]
    mixes = directory / MIXES_DIR
    if mixes.is_dir():
        files += sorted(p for p in mixes.iterdir() if p.is_file())
    return [f for f in files if f.suffix.lower() == ".wav" and f.is_file()]
