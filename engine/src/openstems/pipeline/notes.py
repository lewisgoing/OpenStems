"""Stem to MIDI around a run (Phase 7, stage M3): which stems are read, the two files written
beside each, and reading a stem that is already written.

A stem that is read gets ``<stem>.notes.json``: every note found, each with a confidence,
and the confidence at or above which a note counts (``domain/notes.py`` has the format). The
notes that count are also written as ``<stem>.mid``, plain notes on the song's tempo. A stem
in which nothing was found gets the notes file alone, so the app can say that it looked.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import stat
import sys
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
METHOD = f"swift-f0 {version('swift-f0')}, line segmenter 3"
# A song's MIDI is rounded to keys in the song's own tuning only when the notes of a stem
# with fixed pitches (not a voice) agree on one this tightly. Otherwise keys are at A440.
TUNING_STRENGTH = 0.7
TUNING_LEAST = 5.0  # cents: a song this close to A440 is at A440
PARKED = ".old.tmp"  # what a file held, beside it, until the whole write is done


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


# How much newer than its stem a MIDI file from before its hash was kept may be and still be
# the app's: the two were written one after the other.
LATER_S = 120.0
NOT_WRITTEN = ", so this stem's notes and MIDI were not written"


def track_name(song: str, stem: str) -> str:
    """The name a stem's MIDI file gives its track: the song's and the stem's."""
    return f"{song} {stem}".strip()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def changed(directory: Path, stem: Mapping[str, Any]) -> bool:
    """Whether a stem's MIDI file is no longer what the app wrote: somebody saved another
    over it, or edited it. Such a file is theirs, and the app neither replaces nor removes
    it.

    The manifest keeps the sha256 of the bytes the app wrote (``midi_hash``), and of what
    the file held just before that (``midi_was``): the manifest is written before the
    files it names, so a write that is cut short leaves the older bytes, which are the
    app's as well. A MIDI file from before the hash was kept came with its stem, in the
    same moment. One that is a good deal newer than its stem was saved there later.
    False when the file is gone, or cannot be told from the app's."""
    name = stem.get("midi")
    if not name:
        return False
    path = directory / str(name)
    known = {stem.get("midi_hash"), stem.get("midi_was")} - {None, ""}
    try:
        if known:
            return digest(path.read_bytes()) not in known
        if stem.get("notes"):
            return False  # a development build wrote it, which kept no hash
        return path.stat().st_mtime - (directory / str(stem["file"])).stat().st_mtime > LATER_S
    except OSError:
        return False


def theirs(directory: Path, stem: Mapping[str, Any] | None, base: str) -> tuple[str, str] | None:
    """The file that stands where a stem's notes file or MIDI file (``base`` and a suffix)
    would be written and is not the stem's own to replace, with why; None when there is
    none. ``stem`` is the stem's entry in the folder's manifest, if it has one. Melodyne,
    for one, saves the MIDI it exports as ``<audio name>.mid`` beside the audio."""
    for field, suffix in (("notes", NOTES_SUFFIX), ("midi", MIDI_SUFFIX)):
        name = base + suffix
        if not (directory / name).exists():
            continue
        if stem is None or stem.get(field) != name:
            return name, "is already in the stem folder"
        if field == "midi" and changed(directory, stem):
            return name, "was changed since the app wrote it"
    return None


def theirs_note(stem: str, name: str, why: str) -> str:
    """What a job says of a stem whose notes it did not write, for a file that is not its."""
    return f"{stem}: {name} {why}{NOT_WRITTEN}"


def not_theirs(directory: Path, files: list[str]) -> tuple[list[str], list[str]]:
    """Of the stems named by their files, those whose notes can be written, and what a job
    says of each of the others: where its notes file or MIDI file would go stands a file
    that is not the stem's own (`theirs`). For a run that reads several stems unasked, so
    that one such file does not keep the others from their notes."""
    manifest = read_manifest(directory)
    if manifest is None:
        return files, []
    stems = {str(s["file"]): s for s in manifest.get("stems", [])}
    _adopt(directory, manifest, [stems[file] for file in files if file in stems])
    free: list[str] = []
    said: list[str] = []
    for file in files:
        stem = stems.get(file)
        found = theirs(directory, stem, Path(file).stem) if stem is not None else None
        if stem is None or found is None:
            free.append(file)
        else:
            said.append(theirs_note(str(stem["name"]), *found))
    return free, said


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


def unwritten_note(why: str) -> str:
    """What a job says when a song came from the cache and its notes could not be written."""
    return f"MIDI was not written this time: {why}"


def stale(notes_file: Path) -> bool:
    """Whether a notes file is another transcriber's work, or cannot be read, or is
    damaged: in each case the stem is read again when a cached song is asked for its MIDI."""
    try:
        data = json.loads(notes_file.read_text(encoding="utf-8"))
        from_sidecar(data)
    except Exception:  # not there, not text, not JSON, nested too deep, not a notes file
        return True
    return data.get("method") != METHOD


def chords_note(stem: str) -> str:
    """What a job says of a stem that plays chords and was read as a line all the same."""
    return f"{stem} plays chords: its MIDI holds one line of them"


def job_notes(found: Mapping[str, Transcription]) -> list[str]:
    return [chords_note(name) for name, t in found.items() if t.notes and t.texture == "chords"]


def midi_from_sidecar(data: Any, *, name: str, bpm: float | None, key: str | None) -> bytes | None:
    """The MIDI file of a notes file, under a song's name and on its tempo and key. None
    when the notes file holds no note that counts.

    Every MIDI file the app writes is made this way, from the notes file's own figures, so
    a MIDI file is its notes file and three things from the manifest, to the byte. That is
    how a rename can tell a MIDI file nobody has touched from one changed by hand."""
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
    _adopt(directory, manifest, chosen)
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

    Only a stem's own files are written over or removed: the ones the manifest names (a
    MIDI file only while it is still what the app wrote, `changed`), and ones that are, to
    the byte, what the app writes there (`_adopt`). The manifest is written before the
    files it names: a process that ends in between leaves a manifest naming files that are
    not there yet, which the next reading writes. The other order left files no manifest
    named. For the same reason a stem's notes file is written after its MIDI file: it is
    the notes file that says the stem is read, and on which tuning.
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
    _recover(directory, manifest)
    _adopt(directory, manifest, chosen)
    _in_the_way(directory, chosen)

    analysis = manifest.get("analysis") or {}
    title = str((manifest.get("source") or {}).get("name") or "")
    others = _read_before(directory, manifest.get("stems", []), set(reading.found))
    tuning = song_tuning({**{name: t for name, (_, t) in others.items()}, **reading.found})

    def midi(sidecar: dict[str, Any], name: str) -> bytes | None:
        return midi_from_sidecar(
            sidecar, name=track_name(title, name), bpm=analysis.get("bpm"), key=analysis.get("key")
        )

    # What every file will hold, before anything is touched. Per stem the MIDI file comes
    # before the notes file.
    files: list[tuple[Path, bytes]] = []
    gone: list[Path] = []  # the MIDI file of a stem that holds no notes this time
    for stem in chosen:
        name = str(stem["name"])
        base = Path(str(stem["file"])).stem
        had = stem.get("midi")
        ours = not changed(directory, stem)  # asked before its entry is written anew
        sidecar = sidecar_of(reading.found[name], stem=name, tuning=tuning)
        data = midi(sidecar, name)
        if data is not None:
            files.append((directory / (base + MIDI_SUFFIX), data))
            _names(stem, directory, base + MIDI_SUFFIX, data)
        else:
            _names(stem, directory, None, None)
        files.append((directory / (base + NOTES_SUFFIX), dump(sidecar)))
        stem["notes"] = base + NOTES_SUFFIX
        if had and had != stem["midi"] and ours:
            gone.append(directory / str(had))
    for path in (*(path for path, _ in files), *gone):
        if _read_only(path):
            raise DomainError(f"{path.name} is read-only, so its notes were not written")
    # The stems read before: on the song's tuning if it is another now, and with their MIDI
    # file made again if it has gone missing. A MIDI file somebody changed stays as it is.
    # A stem with a file marked read-only is left whole, on the tuning its notes file says:
    # half of it moved would leave its MIDI file on another tuning than its notes file says.
    for name, (sidecar, _) in others.items():
        stem = by_name[name]
        notes_path = directory / str(stem["notes"])
        midi_path = directory / str(stem["midi"]) if stem.get("midi") else None
        if midi_path is not None and changed(directory, stem):
            midi_path = None
        moved = abs(float(sidecar.get("tuning_cents") or 0.0) - tuning) >= 0.05
        missing = midi_path is not None and not midi_path.exists()
        if not (moved or missing):
            continue
        if _read_only(notes_path) or (midi_path is not None and _read_only(midi_path)):
            continue
        sidecar["tuning_cents"] = tuning
        data = midi(sidecar, name) if midi_path is not None else None
        if midi_path is not None and data is not None:
            files.append((midi_path, data))
            _names(stem, directory, midi_path.name, data)
        if moved:
            files.append((notes_path, dump(sidecar)))
    # What the song's notes say of the stems read now: said once, and taken back for a
    # stem that reads as a line, or reads at all, this time.
    said = {note(name) for name in reading.found for note in (chords_note, failed_note)}
    kept = [
        n
        for n in manifest.get("notes") or []
        if n not in said
        and not (
            n.endswith(NOT_WRITTEN) and n.startswith(tuple(f"{name}: " for name in reading.found))
        )
    ]
    manifest["notes"] = [*kept, *job_notes(reading.found)]

    target = directory / MANIFEST_NAME
    backup = target.with_name(target.name + PARKED)
    parked: list[tuple[Path, Path | None]] = []
    swapped = False
    try:
        # The manifest as it is, kept while there is room for it: putting it back is then a
        # rename, which needs none.
        backup.write_bytes(target.read_bytes())
        # A MIDI file its stem no longer has is moved aside next: open in another program
        # it cannot be, and then nothing has been changed yet.
        for path in gone:
            _park(path, parked)
        _whole(target, json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8"))
        swapped = True
        for path, data in files:
            _swap(path, data, parked)
    except BaseException as exc:
        _undo(parked)
        if swapped:
            with contextlib.suppress(OSError):
                os.replace(backup, target)
        _remove(backup)
        if not isinstance(exc, OSError):
            raise
        raise DomainError(_why(exc)) from exc
    # Done: what was parked goes.
    _remove(backup)
    for path, _ in parked:
        _remove(path.with_name(path.name + PARKED))
    return manifest


def _run_of(manifest: Mapping[str, Any]) -> str:
    """Which run wrote a stem set: a song separated again has another."""
    return f"{manifest.get('created_at')} {manifest.get('cache_key')}"


def _why(exc: OSError, platform: str = sys.platform) -> str:
    """Why nothing was written, for the user. Windows refuses to replace a file another
    program has open. A Mac does not: there, being refused means the folder is not the
    app's to write in (its permissions, or macOS guarding the folder)."""
    which = Path(str(exc.filename)).name if exc.filename else ""
    where = f" ({which})" if which else ""
    if isinstance(exc, PermissionError):
        if platform == "win32":
            return f"a file is open in another program, so its notes were not written{where}"
        return f"this folder cannot be written to, so its notes were not written{where}"
    return f"the notes could not be written: {exc.strerror or exc}{where}"


def _read_only(path: Path) -> bool:
    """Whether the file is there and marked not to be written: its owner's word."""
    return path.exists() and not os.access(path, os.W_OK)


def _remove(path: Path) -> None:
    """Remove a file of the app's own making (a parked file, a backup), read-only or not.
    A failure is not worth stopping for: the next write clears it."""
    try:
        path.unlink(missing_ok=True)
    except PermissionError:
        with contextlib.suppress(OSError):
            path.chmod(stat.S_IWRITE | stat.S_IREAD)
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _names(stem: dict[str, Any], directory: Path, name: str | None, data: bytes | None) -> None:
    """Name in a stem's entry the MIDI file it is about to have, holding ``data``: its hash,
    and with it the hash of what the file holds now, which stays the app's own until the
    new bytes are in its place. None for a stem that has no MIDI file from now on."""
    was = stem.get("midi")
    held: str | None = None
    if was and was == name and not changed(directory, stem):
        with contextlib.suppress(OSError):
            held = digest((directory / str(was)).read_bytes())
    stem["midi"] = name
    for field in ("midi_hash", "midi_was"):
        stem.pop(field, None)
    if name is None or data is None:
        return
    stem["midi_hash"] = digest(data)
    if held and held != stem["midi_hash"]:
        stem["midi_was"] = held


def _recover(directory: Path, manifest: Mapping[str, Any]) -> None:
    """Clear up after a write that was cut short (the process ended partway). A file the
    manifest names that was moved aside and never replaced comes back; whatever else was
    left beside the stems' notes and MIDI files goes."""
    _remove(directory / (MANIFEST_NAME + PARKED))
    _remove(directory / (MANIFEST_NAME + ".notes.tmp"))
    for stem in manifest.get("stems", []):
        base = Path(str(stem["file"])).stem
        named = {str(stem[field]) for field in ("notes", "midi") if stem.get(field)}
        for name in {base + NOTES_SUFFIX, base + MIDI_SUFFIX, *named}:
            _remove(directory / (name + ".tmp"))
            parked = directory / (name + PARKED)
            if not parked.exists():
                continue
            if name in named and not (directory / name).exists():
                # The only copy: if it cannot be brought back now, it is left where it is.
                with contextlib.suppress(OSError):
                    os.replace(parked, directory / name)
                continue
            _remove(parked)


def _adopt(directory: Path, manifest: Mapping[str, Any], chosen: Iterable[dict[str, Any]]) -> None:
    """Take as a stem's own the notes file and the MIDI file under its name that the
    manifest does not name, when they are exactly what the app writes there: a notes file
    of the app's for this stem, and the MIDI file made from that notes file, to the byte.
    ``chosen`` are stems of ``manifest``, which is changed in memory only.

    A write that was cut short by a version that wrote its manifest last left such files,
    and so can a rename or a new tempo that is cut short. Nothing of a user's is mistaken
    for them: a MIDI file somebody saved there is not, byte for byte, what the app makes
    of the notes file beside it. And nothing is lost by replacing them: they can be made
    again from the stem.
    """
    analysis = manifest.get("analysis") or {}
    title = str((manifest.get("source") or {}).get("name") or "")
    for stem in chosen:
        name = str(stem["name"])
        base = Path(str(stem["file"])).stem
        notes_name, midi_name = base + NOTES_SUFFIX, base + MIDI_SUFFIX
        if stem.get("notes") not in (None, notes_name):
            continue  # its manifest names another notes file
        try:
            data = json.loads((directory / notes_name).read_bytes().decode("utf-8"))
            if data.get("format") != SIDECAR_FORMAT or data.get("stem") != name:
                continue
            made = midi_from_sidecar(
                data, name=track_name(title, name), bpm=analysis.get("bpm"), key=analysis.get("key")
            )
        except Exception:  # no notes file there, not one of ours, or damaged: nothing to take
            continue
        stem["notes"] = notes_name
        if stem.get("midi") is None and made is not None:
            with contextlib.suppress(OSError):
                if (directory / midi_name).read_bytes() == made:
                    stem["midi"] = midi_name


def _in_the_way(directory: Path, chosen: Iterable[Mapping[str, Any]]) -> None:
    """Refuse when a notes file or a MIDI file would be written over one that is not the
    stem's own (`theirs`; `_adopt` has taken what is)."""
    for stem in chosen:
        found = theirs(directory, stem, Path(str(stem["file"])).stem)
        if found is None:
            continue
        name, why = found
        if why.startswith("was changed"):
            raise DomainError(
                f"{name} was changed since the app wrote it. Move or rename it, and this "
                "stem's notes can be found again"
            )
        raise DomainError(f"a file named {name} is already in the stem folder")


def _read_before(
    directory: Path, stems: Iterable[Mapping[str, Any]], skip: set[str]
) -> dict[str, tuple[dict[str, Any], Transcription]]:
    """The stems whose notes are known already, apart from those in ``skip``: each one's
    notes file as it is, and what it says of the stem's tuning.

    A notes file that is gone or damaged is left out, and left alone. One that is there and
    cannot be read now (open in another program) stops the write: decided without it, the
    song's tuning could be another than its MIDI file is on."""
    out: dict[str, tuple[dict[str, Any], Transcription]] = {}
    for stem in stems:
        name = str(stem["name"])
        if name in skip or not stem.get("notes") or line_kind(name) is None:
            continue
        try:
            raw = (directory / str(stem["notes"])).read_bytes()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise DomainError(_why(exc)) from exc
        try:
            data = json.loads(raw.decode("utf-8"))
            notes, meta = from_sidecar(data)
            threshold = float(meta.get("threshold") or 0.0)
            sure = [n for n in notes if n.confidence is None or n.confidence >= threshold] or notes
            pitches, weights = [n.pitch for n in sure], [n.duration for n in sure]
            read = Transcription(
                notes=tuple(notes),
                threshold=threshold,
                tuning_cents=round(estimate_tuning(pitches, weights), 1) if sure else 0.0,
                tuning_strength=round(tuning_strength(pitches, weights), 3),
                profile=line_kind(name) or "line",
            )
        except Exception:  # whatever is wrong with it: it is not this write's to mend
            continue
        out[name] = (data, read)
    return out


# Files are replaced so that putting them back needs no room and cannot leave half a file:
# what a file held is parked beside it, by a rename, until the whole write is done.


def _whole(path: Path, data: bytes) -> None:
    """Write the manifest through a temp file beside it: a reader sees the old one or the
    new one, never neither and never half."""
    beside = path.with_name(path.name + ".notes.tmp")  # not a retag's or a rename's temp file
    try:
        beside.write_bytes(data)
        os.replace(beside, path)
    except OSError:
        with contextlib.suppress(OSError):
            beside.unlink(missing_ok=True)
        raise


def _park(path: Path, parked: list[tuple[Path, Path | None]]) -> None:
    """Move the file at ``path`` aside, and note it for `_undo`. A file that is open in
    another program cannot be moved (on Windows), and then nothing has been changed."""
    if path.is_file():
        beside = path.with_name(path.name + PARKED)
        _remove(beside)  # left by a write that was cut short
        os.replace(path, beside)
        parked.append((path, beside))
    else:
        parked.append((path, None))


def _swap(path: Path, data: bytes, parked: list[tuple[Path, Path | None]]) -> None:
    """Put ``data`` where ``path`` is, with what was there parked beside it. The new bytes
    are written first: with no room for them, nothing has been moved."""
    beside = path.with_name(path.name + ".tmp")
    try:
        beside.write_bytes(data)
        _park(path, parked)
        os.replace(beside, path)
    except OSError:
        with contextlib.suppress(OSError):
            beside.unlink(missing_ok=True)
        raise


def _undo(parked: list[tuple[Path, Path | None]]) -> None:
    """Put every file back as it was, the last one first: a rename each, or for a file that
    was not there, its removal."""
    for path, beside in reversed(parked):
        with contextlib.suppress(OSError):
            if beside is None:
                path.unlink(missing_ok=True)
            else:
                os.replace(beside, path)
