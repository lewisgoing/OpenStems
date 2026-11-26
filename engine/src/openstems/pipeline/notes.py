"""Stem to MIDI around a run (Phase 7, stage M3): which stems are read, the two files written
beside each, and reading a stem that is already written.

A stem that is read gets ``<stem>.notes.json``: every note found, each with a confidence,
and the confidence at or above which a note counts (``domain/notes.py`` has the format). The
notes that count are also written as ``<stem>.mid``, plain notes on the song's tempo. A stem
in which nothing was found gets the notes file alone, so the app can say that it looked.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

from openstems.audio.midi import Part, midi_file_bytes
from openstems.audio.transcribe import PROFILES, Transcription, transcribe_line, tuning_strength
from openstems.audio.write import read_audio
from openstems.domain.errors import DomainError
from openstems.domain.levels import empty_stems
from openstems.domain.notes import (
    MIDI_SUFFIX,
    NOTES_SUFFIX,
    SIDECAR_FORMAT,
    Note,
    estimate_tuning,
    from_sidecar,
    line_kind,
    to_sidecar,
)
from openstems.domain.stem import MANIFEST_NAME
from openstems.pipeline.run import read_manifest

log = logging.getLogger(__name__)

# What wrote a notes file: SwiftF0's version and this transcriber's own. A cached song whose
# notes say otherwise is read again (`stale`), so raise the last number whenever the notes a
# stem gives change: a new weight, a new rule.
METHOD = f"swift-f0 {version('swift-f0')}, line segmenter 1"
# A song's MIDI is rounded to keys in the song's own tuning only when the notes of a stem
# with fixed pitches (not a voice) agree on one this tightly. Otherwise keys are at A440.
TUNING_STRENGTH = 0.7
TUNING_LEAST = 5.0  # cents: a song this close to A440 is at A440


def readable(
    names: Iterable[str], wanted: Iterable[str], peaks: Mapping[str, float | None]
) -> list[str]:
    """The stems to read: asked for (whatever the case of the name: a recipe of the user's
    may call its stem "Bass"), with a line to follow, and not empty."""
    asked = {name.lower() for name in wanted}
    empty = empty_stems(peaks)
    return [n for n in names if n.lower() in asked and line_kind(n) is not None and n not in empty]


def song_tuning(found: Mapping[str, Transcription]) -> float:
    """One tuning, in cents from A440, for every MIDI file of a song: that of the stem whose
    notes agree on one most firmly, counting only stems with fixed pitches. A voice follows
    the song's tuning; it does not set it. 0 when no stem is sure enough."""
    best = (0.0, 0.0)
    for transcription in found.values():
        if transcription.profile == "voice":
            continue
        if transcription.tuning_strength < TUNING_STRENGTH:
            continue
        weight = transcription.tuning_strength * sum(n.duration for n in transcription.shown())
        if weight > best[0]:
            best = (weight, transcription.tuning_cents)
    return best[1] if abs(best[1]) >= TUNING_LEAST else 0.0


def midi_of(
    notes: list[Note], *, stem: str, name: str, bpm: float | None, key: str | None, tuning: float
) -> bytes:
    """One stem's notes as a MIDI file: one track, plain notes, the song's tempo and key."""
    profile = PROFILES[line_kind(stem) or "line"]
    part = Part(name, notes, program=profile.program)
    return midi_file_bytes(
        [part], bpm=bpm or 120.0, key=key, tuning_cents=tuning, single_track=True
    )


def sidecar_of(transcription: Transcription, *, stem: str, tuning: float) -> dict[str, Any]:
    return to_sidecar(
        transcription.notes,
        stem=stem,
        tuning_cents=tuning,
        method=METHOD,
        threshold=transcription.threshold,
        texture=transcription.texture,
    )


def failed_note(stem: str) -> str:
    """What a job says of a stem whose notes could not be read at all."""
    return f"{stem}: its notes could not be read, so it has no MIDI"


def stale(notes_file: Path) -> bool:
    """Whether a notes file is another transcriber's work (or cannot be read)."""
    try:
        data = json.loads(notes_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return not isinstance(data, dict) or data.get("method") != METHOD


def chords_note(stem: str) -> str:
    """What a job says of a stem that plays chords and was read as a line all the same."""
    return f"{stem} plays chords: its MIDI holds one line of them"


def job_notes(found: Mapping[str, Transcription]) -> list[str]:
    return [chords_note(name) for name, t in found.items() if t.notes and t.texture == "chords"]


def midi_from_sidecar(data: Any, *, name: str, bpm: float | None, key: str | None) -> bytes | None:
    """The MIDI file of a notes file, on another tempo or key: what a retag writes. None
    when the notes file holds no note that counts."""
    notes, meta = from_sidecar(data)
    threshold = float(meta.get("threshold") or 0.0)
    shown = [n for n in notes if n.confidence is None or n.confidence >= threshold]
    if not shown:
        return None
    return midi_of(
        shown,
        stem=str(meta.get("stem") or ""),
        name=name,
        bpm=bpm,
        key=key,
        tuning=float(meta.get("tuning_cents") or 0.0),
    )


def dump(data: dict[str, Any]) -> bytes:
    """A notes file's bytes: compact, since a long stem holds thousands of curve points."""
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


# -- a stem that is already written ---------------------------------------------------------
#
# Reading takes seconds and writing takes none, so they are two steps. `read_stems` writes
# nothing. `write_notes` reads the manifest afresh and changes only what the notes need, so a
# tempo typed, a stem hidden or a file renamed while the stems were being read is kept. The
# API holds its lock on the folder for the second step only (`Service.find_notes`).


@dataclass(frozen=True)
class Reading:
    """What was found in stems of one stem set, before anything is written: each stem's
    notes by its name, and which run's stems they were read from."""

    run: str
    found: Mapping[str, Transcription]


def find_notes(directory: Path, files: list[str]) -> dict[str, Any]:
    """Read stems of the stem set in ``directory`` that are already written, and write each
    one's notes file and MIDI file beside it. ``files`` are the stems' file names. Returns
    the new manifest.

    A stem that has its notes already is read again: the files are replaced. Nothing is
    changed when any of the stems cannot be read, and a file of the same name that is not
    this stem's own is never written over.
    """
    return write_notes(directory, read_stems(directory, files))


def read_stems(directory: Path, files: list[str]) -> Reading:
    """The notes of stems that are already written. Nothing is written or changed."""
    if not files:
        raise DomainError("name the stems to find notes in")
    manifest = read_manifest(directory)
    if manifest is None or not manifest.get("complete"):
        raise DomainError("that folder does not hold a set of stems")
    stems = {str(s["file"]): s for s in manifest.get("stems", [])}
    chosen = []
    for file in files:
        stem = stems.get(file)
        if stem is None:
            raise DomainError(f"{file} is not a stem of this song")
        if line_kind(str(stem["name"])) is None:
            raise DomainError(
                f"{stem['name']} has no single line to read: notes are found for voices, "
                "basses and other pitched stems"
            )
        if not (directory / file).is_file():
            raise DomainError(f"{file} is no longer in its folder: separate the song again")
        chosen.append(stem)
    _in_the_way(directory, chosen)  # before the seconds of reading, and again before writing
    found: dict[str, Transcription] = {}
    for stem in chosen:
        name = str(stem["name"])
        try:
            audio, rate = read_audio(directory / str(stem["file"]))
            found[name] = transcribe_line(audio, rate, name)
        except Exception as exc:
            log.exception("stem to MIDI failed for %s in %s", stem["file"], directory)
            raise DomainError(f"cannot read the notes of {stem['file']}: {exc}") from exc
    return Reading(_run_of(manifest), found)


def write_notes(directory: Path, reading: Reading) -> dict[str, Any]:
    """Write what ``read_stems`` found: each stem's notes file and MIDI file, and the
    manifest as it is now with those named in it. Returns that manifest.

    One tuning holds for every MIDI file of the song (`song_tuning`, over every stem whose
    notes are known), so when a stem read now settles another tuning, the MIDI files of the
    stems read before are rounded again from their notes files. Either all of it is written
    or the folder is left as it was.
    """
    manifest = read_manifest(directory)
    if manifest is None or not manifest.get("complete"):
        raise DomainError(
            "this song was moved or renamed while its notes were being found: find them again"
        )
    if _run_of(manifest) != reading.run:
        raise DomainError(
            "this song was separated again while its notes were being found: find them again"
        )
    by_name = {str(s["name"]): s for s in manifest.get("stems", [])}
    chosen = [by_name[name] for name in reading.found if name in by_name]
    if len(chosen) != len(reading.found):
        raise DomainError("this song's stems changed while its notes were being found")
    for stem in chosen:
        if not (directory / str(stem["file"])).is_file():
            raise DomainError(f"{stem['file']} is no longer in its folder")
    _in_the_way(directory, chosen)

    analysis = manifest.get("analysis") or {}
    title = str((manifest.get("source") or {}).get("name") or "")
    others = _read_before(directory, manifest.get("stems", []), set(reading.found))
    tuning = song_tuning({**{name: t for name, (_, t) in others.items()}, **reading.found})

    undo: list[tuple[Path, bytes | None]] = []
    unneeded: list[Path] = []  # a MIDI file of a stem that holds no notes this time
    try:
        for stem in chosen:
            name = str(stem["name"])
            transcription = reading.found[name]
            base = Path(str(stem["file"])).stem
            notes_path = directory / (base + NOTES_SUFFIX)
            _replace(notes_path, dump(sidecar_of(transcription, stem=name, tuning=tuning)), undo)
            stem["notes"] = notes_path.name
            shown = transcription.shown()
            midi_path = directory / (base + MIDI_SUFFIX)
            if shown:
                data = midi_of(
                    shown,
                    stem=name,
                    name=f"{title} {name}".strip(),
                    bpm=analysis.get("bpm"),
                    key=analysis.get("key"),
                    tuning=tuning,
                )
                _replace(midi_path, data, undo)
                stem["midi"] = midi_path.name
            else:
                if stem.get("midi"):
                    unneeded.append(directory / str(stem["midi"]))
                elif midi_path.exists():  # left by a write that never reached the manifest
                    unneeded.append(midi_path)
                stem["midi"] = None
        # The stems read before, on the song's tuning if it is another now.
        for name, (sidecar, _) in others.items():
            if abs(float(sidecar.get("tuning_cents") or 0.0) - tuning) < 0.05:
                continue
            stem = by_name[name]
            sidecar["tuning_cents"] = tuning
            _replace(directory / str(stem["notes"]), dump(sidecar), undo)
            if stem.get("midi"):
                data = midi_from_sidecar(
                    sidecar,
                    name=f"{title} {name}".strip(),
                    bpm=analysis.get("bpm"),
                    key=analysis.get("key"),
                )
                if data is not None:
                    _replace(directory / str(stem["midi"]), data, undo)
        # What the song's notes say of the stems read now: said once, and taken back for a
        # stem that reads as a line, or reads at all, this time.
        said = {note(name) for name in reading.found for note in (chords_note, failed_note)}
        kept = [n for n in manifest.get("notes") or [] if n not in said]
        manifest["notes"] = [*kept, *job_notes(reading.found)]
        _replace(
            directory / MANIFEST_NAME,
            json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8"),
            undo,
            tmp=".notes.tmp",  # not the temp file a retag or a rename writes its manifest to
        )
    except OSError as exc:
        _undo(undo)
        which = Path(str(exc.filename)).name if exc.filename else str(exc)
        raise DomainError(
            f"a file is open in another program, so its notes were not written ({which})"
        ) from exc
    except BaseException:
        _undo(undo)
        raise
    # Only now, with the manifest saying so: until here a failure left every old file. A
    # MIDI file that cannot go (open in a DAW) is this stem's own the next time all the same.
    for path in unneeded:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            log.warning("could not remove %s, which its stem no longer has", path)
    return manifest


def _run_of(manifest: Mapping[str, Any]) -> str:
    """Which run wrote a stem set: a song separated again has another."""
    return f"{manifest.get('created_at')} {manifest.get('cache_key')}"


def _own_notes(path: Path, stem: str) -> bool:
    """Whether the file is a notes file this app wrote for that stem."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return (
        isinstance(data, dict) and data.get("format") == SIDECAR_FORMAT and data.get("stem") == stem
    )


def _in_the_way(directory: Path, chosen: Iterable[Mapping[str, Any]]) -> None:
    """Refuse when a notes file or a MIDI file would be written over one that is not the
    stem's own. Its own are the ones its manifest names, and also a notes file this app
    wrote for it with the MIDI file beside that: a write that was cut short before its
    manifest leaves those, and they must not be in the way for ever."""
    for stem in chosen:
        base = Path(str(stem["file"])).stem
        notes_name, midi_name = base + NOTES_SUFFIX, base + MIDI_SUFFIX
        notes_path, midi_path = directory / notes_name, directory / midi_name
        own = stem.get("notes") == notes_name or _own_notes(notes_path, str(stem["name"]))
        if notes_path.exists() and not own:
            raise DomainError(f"a file named {notes_name} is already in the stem folder")
        if midi_path.exists() and stem.get("midi") != midi_name and not own:
            raise DomainError(f"a file named {midi_name} is already in the stem folder")


def _read_before(
    directory: Path, stems: Iterable[Mapping[str, Any]], skip: set[str]
) -> dict[str, tuple[dict[str, Any], Transcription]]:
    """The stems whose notes are known already, apart from those in ``skip``: each one's
    notes file as it is, and what it says of the stem's tuning. A notes file that cannot be
    read is left out, and left alone."""
    out: dict[str, tuple[dict[str, Any], Transcription]] = {}
    for stem in stems:
        name = str(stem["name"])
        if name in skip or not stem.get("notes"):
            continue
        try:
            data = json.loads((directory / str(stem["notes"])).read_text(encoding="utf-8"))
            notes, meta = from_sidecar(data)
        except (OSError, ValueError, DomainError):
            continue
        threshold = float(meta.get("threshold") or 0.0)
        sure = [n for n in notes if n.confidence is None or n.confidence >= threshold] or notes
        pitches, weights = [n.pitch for n in sure], [n.duration for n in sure]
        out[name] = (
            data,
            Transcription(
                notes=tuple(notes),
                threshold=threshold,
                tuning_cents=round(estimate_tuning(pitches, weights), 1) if sure else 0.0,
                tuning_strength=round(tuning_strength(pitches, weights), 3),
                profile=line_kind(name) or "line",
            ),
        )
    return out


def _replace(
    path: Path, data: bytes, undo: list[tuple[Path, bytes | None]], tmp: str = ".tmp"
) -> None:
    """Write through a temp file beside it, so a reader never sees half a file. What the
    file held before (None: there was none) goes on ``undo`` first."""
    try:
        before = path.read_bytes()
    except FileNotFoundError:
        before = None
    undo.append((path, before))
    beside = path.with_name(path.name + tmp)
    try:
        beside.write_bytes(data)
        os.replace(beside, path)
    except OSError:
        with contextlib.suppress(OSError):
            beside.unlink(missing_ok=True)
        raise


def _undo(undo: list[tuple[Path, bytes | None]]) -> None:
    """Put every file back as it was, the last one written first."""
    for path, before in reversed(undo):
        with contextlib.suppress(OSError):
            if before is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(before)
