"""Note objects for stem to MIDI (Phase 7, stage M1): plain functions, no torch, no numpy.

A transcriber returns :class:`Note` values; the MIDI writer (``audio/midi.py``) and the notes
file beside each stem (``<stem>.notes.json``, :func:`to_sidecar`) both read them. A note keeps
its pitch as a fractional MIDI number, so nothing is lost before export: which key it goes to
is decided at export, against the song's tuning (:func:`round_pitch`).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from openstems.domain.errors import DomainError

SIDECAR_FORMAT = "openstems.notes"
SIDECAR_VERSION = 1
KINDS = ("pitched", "drums")
NOTES_SUFFIX = ".notes.json"  # after the stem file's own name, without its extension
MIDI_SUFFIX = ".mid"


@dataclass(frozen=True)
class Note:
    """One note. Times are seconds from the stem's first sample.

    ``pitch`` is a MIDI note number with cents as the fraction (60.25 is C4 plus 25 cents).
    ``bend`` is the pitch curve: ``(seconds from start, semitones from pitch)`` points in time
    order, empty for a steady note. ``drum`` names the kit part for drum notes, whose
    ``pitch`` is then the General MIDI drum note.
    """

    start: float
    end: float
    pitch: float
    velocity: int = 100
    confidence: float | None = None
    bend: tuple[tuple[float, float], ...] = ()
    drum: str | None = None

    def __post_init__(self) -> None:
        if not (math.isfinite(self.start) and math.isfinite(self.end)):
            raise DomainError("a note's start and end must be numbers")
        if self.start < 0 or self.end <= self.start:
            raise DomainError(f"a note must end after it starts ({self.start} to {self.end})")
        if not 0 <= self.pitch <= 127:
            raise DomainError(f"a note's pitch must be within MIDI's range, not {self.pitch}")
        if isinstance(self.velocity, bool) or not isinstance(self.velocity, int):
            raise DomainError(f"a note's velocity must be a whole number, not {self.velocity!r}")
        if not 1 <= self.velocity <= 127:
            raise DomainError(f"a note's velocity must be 1 to 127, not {self.velocity}")
        if self.confidence is not None and not 0 <= self.confidence <= 1:
            raise DomainError(f"a note's confidence must be 0 to 1, not {self.confidence}")
        last = -1.0
        for t, semitones in self.bend:
            if not (math.isfinite(t) and math.isfinite(semitones)):
                raise DomainError("a note's bend points must be numbers")
            if t < last or t < 0 or t > self.end - self.start + 1e-9:
                raise DomainError("a note's bend points must be in order and within the note")
            last = t

    @property
    def duration(self) -> float:
        return self.end - self.start

    def bend_at(self, offset: float) -> float:
        """The curve's value ``offset`` seconds into the note, held between points."""
        value = 0.0
        for t, semitones in self.bend:
            if t > offset:
                break
            value = semitones
        return value


# -- which stems hold a line to read ------------------------------------------------------
#
# The recipes name their stems; the name says how a stem is read (the routing table in
# docs/research/stem-to-midi.md, section 5). Chords are stage M4: until then a stem that may
# hold them is read as a line, and gives its most prominent one.

VOICE_STEMS = frozenset({"vocals", "lead vocals", "lead", "dry vocals", "lead-vocal", "vocal"})
BASS_STEMS = frozenset({"bass", "double-bass", "tuba"})
# No pitch to follow: drums and percussion (stage M2 reads their hits).
DRUM_STEMS = frozenset(
    {"drums", "kick", "snare", "toms", "hh", "ride", "crash", "other drums", "kit-rest"}
    | {"percussion", "congas", "tambourine", "triangle", "timpani", "wind-chimes"}
)
# Several parts at once, by design: never transcribed.
MIXTURE_STEMS = frozenset({"instrumental", "drumless", "no-drums", "clean", "dry", "mix"})
# The stems that get a MIDI file when the write_midi setting is on: the ones that are a
# single line by nature, and the melody recipe's stem.
MIDI_STEMS = tuple(sorted(VOICE_STEMS | BASS_STEMS | {"melody"}))


def line_kind(stem: str) -> str | None:
    """How a stem is read as a single line: ``voice``, ``bass`` or ``line`` (anything else
    with a pitch). None for drums, percussion and mixtures, which have no line to read."""
    name = stem.strip().lower()
    if name in VOICE_STEMS:
        return "voice"
    if name in BASS_STEMS:
        return "bass"
    if name in DRUM_STEMS or name in MIXTURE_STEMS:
        return None
    return "line"


def estimate_tuning(pitches: Iterable[float], weights: Iterable[float] | None = None) -> float:
    """The song's tuning in cents from A440, in [-50, 50): the circular mean of the notes'
    fractional pitches, weighted (by duration, say) when weights are given. 0 with no notes.
    """
    values = list(pitches)
    w = list(weights) if weights is not None else [1.0] * len(values)
    x = sum(wi * math.cos(2 * math.pi * p) for p, wi in zip(values, w, strict=True))
    y = sum(wi * math.sin(2 * math.pi * p) for p, wi in zip(values, w, strict=True))
    if abs(x) < 1e-12 and abs(y) < 1e-12:
        return 0.0
    cents = math.atan2(y, x) / (2 * math.pi) * 100
    return -50.0 if cents >= 50 else cents


def round_pitch(pitch: float, tuning_cents: float = 0.0) -> tuple[int, float]:
    """The MIDI key for ``pitch`` heard against a tuning, and the rest in semitones (the
    tuning included: what a pitch bend must add). In a song tuned 30 cents sharp, 60.6 goes
    to key 60, a slightly sharp C there, where plain rounding would make it 61."""
    shifted = pitch - tuning_cents / 100
    key = min(127, max(0, math.floor(shifted + 0.5)))
    return key, pitch - key


def velocity_from_db(level_db: float, floor_db: float = -50.0, ceiling_db: float = 0.0) -> int:
    """A note's level in dBFS as a MIDI velocity: linear in decibels from ``floor_db``
    (velocity 1) to ``ceiling_db`` (127), clamped."""
    if not math.isfinite(level_db):
        return 1
    share = (level_db - floor_db) / (ceiling_db - floor_db)
    return min(127, max(1, round(1 + share * 126)))


# -- the notes file beside each stem --------------------------------------------------------


def _number(value: float, places: int = 4) -> float:
    return round(float(value), places)


def to_sidecar(
    notes: Sequence[Note],
    *,
    stem: str,
    kind: str = "pitched",
    tuning_cents: float = 0.0,
    method: str = "",
    threshold: float | None = None,
    texture: str = "",
) -> dict[str, Any]:
    """The JSON object of ``<stem>.notes.json``. Version 1; readers refuse later versions.

    ``threshold`` is the confidence at or above which a note counts as part of the
    transcription. The notes under it are candidates: found, but not sure enough to be in
    the MIDI file. ``tuning_cents`` is the tuning the MIDI file's keys were chosen against.
    ``texture`` is ``line`` for a stem that plays one note at a time and ``chords`` for one
    that plays several, of which the notes here are only one line.

    Times are rounded to a tenth of a millisecond. Rounding a note's start and end can
    shorten it by that much, so its bend points are held within the rounded note: what is
    written here always reads back."""
    if kind not in KINDS:
        raise DomainError(f"a notes file is for {' or '.join(KINDS)} stems, not {kind!r}")
    out = []
    for n in sorted(notes, key=lambda n: (n.start, n.pitch)):
        start, end = _number(n.start), _number(n.end)
        if end <= start:
            end = _number(start + 0.0001)
        length = _number(end - start)
        entry: dict[str, Any] = {
            "start": start,
            "end": end,
            "pitch": _number(n.pitch),
            "velocity": n.velocity,
        }
        if n.confidence is not None:
            entry["confidence"] = _number(n.confidence, 3)
        if n.bend:
            entry["bend"] = [[min(_number(t), length), _number(s)] for t, s in n.bend]
        if n.drum:
            entry["drum"] = n.drum
        out.append(entry)
    return {
        "format": SIDECAR_FORMAT,
        "version": SIDECAR_VERSION,
        "stem": stem,
        "kind": kind,
        "tuning_cents": _number(tuning_cents, 2),
        "method": method,
        **({"threshold": _number(threshold, 3)} if threshold is not None else {}),
        **({"texture": texture} if texture else {}),
        "notes": out,
    }


def from_sidecar(data: Any) -> tuple[list[Note], dict[str, Any]]:
    """The notes of a notes file and its other fields. Raises DomainError on anything that
    is not a version 1 notes file."""
    if not isinstance(data, dict) or data.get("format") != SIDECAR_FORMAT:
        raise DomainError("not an OpenStems notes file")
    version = data.get("version")
    if version != SIDECAR_VERSION:
        raise DomainError(f"notes file version {version} is not supported")
    if data.get("kind") not in KINDS or not isinstance(data.get("notes"), list):
        raise DomainError("the notes file is damaged")
    notes = []
    for entry in data["notes"]:
        try:
            notes.append(
                Note(
                    start=float(entry["start"]),
                    end=float(entry["end"]),
                    pitch=float(entry["pitch"]),
                    velocity=int(entry.get("velocity", 100)),
                    confidence=(
                        float(entry["confidence"]) if entry.get("confidence") is not None else None
                    ),
                    bend=tuple((float(t), float(s)) for t, s in entry.get("bend", ())),
                    drum=entry.get("drum"),
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise DomainError(f"the notes file is damaged: {exc}") from exc
    meta = {k: v for k, v in data.items() if k != "notes"}
    return notes, meta
