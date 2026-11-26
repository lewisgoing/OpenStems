"""Stem to MIDI around a run (Phase 7, stage M3): which stems are read, the two files written
beside each, and reading a stem that is already written.

A stem that is read gets ``<stem>.notes.json``: every note found, each with a confidence,
and the confidence at or above which a note counts (``domain/notes.py`` has the format). The
notes that count are also written as ``<stem>.mid``, plain notes on the song's tempo. A stem
in which nothing was found gets the notes file alone, so the app can say that it looked.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from openstems.audio.midi import Part, midi_file_bytes
from openstems.audio.transcribe import PROFILES, Transcription, transcribe_line
from openstems.audio.write import read_audio
from openstems.domain.errors import DomainError
from openstems.domain.levels import empty_stems
from openstems.domain.notes import (
    MIDI_SUFFIX,
    NOTES_SUFFIX,
    Note,
    from_sidecar,
    line_kind,
    to_sidecar,
)
from openstems.domain.stem import MANIFEST_NAME
from openstems.pipeline.run import read_manifest

METHOD = "swift-f0 0.3.0, line segmenter 1"
# A song's MIDI is rounded to keys in the song's own tuning only when the notes of a stem
# with fixed pitches (not a voice) agree on one this tightly. Otherwise keys are at A440.
TUNING_STRENGTH = 0.7


def readable(
    names: Iterable[str], wanted: Iterable[str], peaks: Mapping[str, float | None]
) -> list[str]:
    """The stems to read: asked for, with a line to follow, and not empty."""
    asked = set(wanted)
    empty = empty_stems(peaks)
    return [n for n in names if n in asked and line_kind(n) is not None and n not in empty]


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
    return best[1]


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


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


# -- a stem that is already written ---------------------------------------------------------


def find_notes(directory: Path, files: list[str]) -> dict[str, Any]:
    """Read stems of the stem set in ``directory`` that are already written, and write each
    one's notes file and MIDI file beside it. ``files`` are the stems' file names. Returns
    the new manifest.

    A stem that has its notes already is read again: the files are replaced. Nothing is
    changed when any of the stems cannot be read, and a file of the same name that is not
    this stem's own is never written over.
    """
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
    known = {str(s.get(field)) for s in stems.values() for field in ("midi", "notes")}
    present = {name.lower() for name in os.listdir(directory)}
    for stem in chosen:
        base = Path(str(stem["file"])).stem
        for target in (base + MIDI_SUFFIX, base + NOTES_SUFFIX):
            if target.lower() in present and target not in known:
                raise DomainError(f"a file named {target} is already in the stem folder")

    analysis = manifest.get("analysis") or {}
    title = str((manifest.get("source") or {}).get("name") or "")
    found: dict[str, Transcription] = {}
    for stem in chosen:
        audio, rate = read_audio(directory / str(stem["file"]))
        found[str(stem["name"])] = transcribe_line(audio, rate, str(stem["name"]))
    tuning = _tuning_in_use(directory, stems.values()) or song_tuning(found)

    written: list[Path] = []
    there = {path.name for path in directory.iterdir()}
    try:
        for stem in chosen:
            name = str(stem["name"])
            transcription = found[name]
            base = Path(str(stem["file"])).stem
            notes_path = directory / (base + NOTES_SUFFIX)
            _replace(
                notes_path, _dump(sidecar_of(transcription, stem=name, tuning=tuning)), written
            )
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
                _replace(midi_path, data, written)
                stem["midi"] = midi_path.name
            else:
                if stem.get("midi"):
                    (directory / str(stem["midi"])).unlink(missing_ok=True)
                stem["midi"] = None
        # What the song's notes say of the stems read now: said once, and taken back for a
        # stem that reads as a line this time.
        stale = {chords_note(name) for name in found}
        kept = [n for n in manifest.get("notes") or [] if n not in stale]
        manifest["notes"] = [*kept, *job_notes(found)]
        _replace(
            directory / MANIFEST_NAME,
            json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8"),
            written,
        )
    except OSError as exc:
        # Leave the folder as its manifest describes it: no half-written file, and no new
        # file the manifest does not name (it would be in the way the next time).
        for path in written:
            path.with_name(path.name + ".tmp").unlink(missing_ok=True)
            if path.name not in there:
                path.unlink(missing_ok=True)
        which = Path(str(exc.filename)).name if exc.filename else str(exc)
        raise DomainError(
            f"a file is open in another program, so its notes were not written ({which})"
        ) from exc
    return manifest


def _dump(data: dict[str, Any]) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _replace(path: Path, data: bytes, written: list[Path]) -> None:
    """Write through a temp file beside it, so a reader never sees half a file."""
    written.append(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _tuning_in_use(directory: Path, stems: Iterable[Mapping[str, Any]]) -> float:
    """The tuning the song's notes files were written with, so a stem read later lands on
    the same keys as the ones read with the song. 0 when there is none."""
    for stem in stems:
        name = stem.get("notes")
        if not name:
            continue
        try:
            data = json.loads((directory / str(name)).read_text(encoding="utf-8"))
            tuning = float(data.get("tuning_cents") or 0.0)
        except (OSError, ValueError, AttributeError):
            continue
        if tuning:
            return tuning
    return 0.0
