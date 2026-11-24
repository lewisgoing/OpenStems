"""A song's beat grid, and a stretch of the song named in a few words.

Everything is in seconds of the song's own timeline, which the source file and every stem
share. The app keeps a twin of these functions in TypeScript: the same arithmetic in the
same order, so that both name a selection alike, digit for digit. JavaScript's
``Math.round`` sends a half up (2.5 is 3), where Python's ``round`` sends it to the even
number, so `js_round` stands in for it here.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from openstems.domain.errors import DomainError

# A point this close to a grid line is on it, in seconds.
EPS = 0.0015
MIN_BPM = 20.0
MAX_BPM = 999.0
# Where bar 1 may be: before the file starts (a pickup), up to a day into it.
MIN_DOWNBEAT = -60.0
MAX_DOWNBEAT = 86400.0
MAX_BEATS_PER_BAR = 16
# The shortest selection worth a file or a separation of its own (MIN_RANGE in the app).
MIN_SELECTION = 0.02

_DOWNBEAT_ERROR = "bar 1 must be a time in seconds"
# A number as text, as the app's `cleanDownbeat` reads one (its `NUMBER`): ASCII digits
# only, where Python's float would also take "1_0" and digits of other scripts.
_NUMBER = re.compile(r"[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?", re.IGNORECASE | re.ASCII)


@dataclass(frozen=True)
class Grid:
    """A song's beat grid: its tempo, where beat 1 of bar 1 is, in seconds from the start of
    the file (negative when bar 1 starts before it), and the beats in a bar."""

    bpm: float
    downbeat: float
    beats_per_bar: int = 4


def js_round(x: float) -> int:
    """``Math.round`` of JavaScript: the nearest integer, a half rounded up."""
    whole = math.floor(x)
    return whole + 1 if x - whole >= 0.5 else whole


def beat_seconds(grid: Grid) -> float:
    return 60 / grid.bpm


def beat_at(grid: Grid, t: float) -> float:
    """Beats from beat 1 of bar 1 to ``t`` (negative before it)."""
    return (t - grid.downbeat) / beat_seconds(grid)


def bar_at(grid: Grid, t: float) -> int:
    """The bar ``t`` falls in: bar 1 starts at the downbeat, a pickup before it is bar 0."""
    return math.floor(beat_at(grid, t) / grid.beats_per_bar + 1e-9) + 1


def is_on(grid: Grid, t: float, step_beats: float) -> bool:
    """Whether ``t`` sits on a line every ``step_beats`` beats."""
    steps = beat_at(grid, t) / step_beats
    return abs(steps - js_round(steps)) * step_beats * beat_seconds(grid) < EPS


def format_position(grid: Grid, t: float) -> str:
    """Bar, beat and sixteenth of a point, 1-based: ``9.3``, or ``9.3.2`` between beats."""
    beats = beat_at(grid, t)
    bar = math.floor(beats / grid.beats_per_bar + 1e-9) + 1
    in_bar = beats - (bar - 1) * grid.beats_per_bar
    beat = math.floor(in_bar + 1e-9) + 1
    sixteenth = math.floor((in_bar - (beat - 1)) * 4 + 1e-6) + 1
    return f"{bar}.{beat}.{sixteenth}" if sixteenth > 1 else f"{bar}.{beat}"


def file_time(t: float) -> str:
    """A point in time for a file name, where ":" is not allowed: ``1m02.35s``."""
    cs = js_round(max(0.0, t) * 100)
    return f"{cs // 6000}m{cs % 6000 // 100:02d}.{cs % 100:02d}s"


def clip_label(grid: Grid | None, start: float, end: float) -> str:
    """A selection in a few words, for its file name: ``bars 9-16`` or ``bar 9`` when both
    ends sit on bar lines, ``9.3-11.2`` when both sit on beats, times otherwise."""
    if grid is not None:
        per_bar = grid.beats_per_bar
        if is_on(grid, start, per_bar) and is_on(grid, end, per_bar):
            first = bar_at(grid, start + EPS)
            last = bar_at(grid, end - EPS)
            return f"bar {first}" if first == last else f"bars {first}-{last}"
        if is_on(grid, start, 1) and is_on(grid, end, 1):
            return f"{format_position(grid, start)}-{format_position(grid, end)}"
    return f"{file_time(start)}-{file_time(end)}"


def clean_downbeat(value: Any) -> float | None:
    """Where bar 1 starts, as the manifest holds it: seconds kept to four decimals, or None
    for none. The app's twin rounds the same way: ``Math.round(x * 10000) / 10000``."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, bool) or (isinstance(value, str) and not _NUMBER.fullmatch(value.strip())):
        raise DomainError(_DOWNBEAT_ERROR)
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        raise DomainError(_DOWNBEAT_ERROR) from None
    if not (math.isfinite(seconds) and MIN_DOWNBEAT <= seconds <= MAX_DOWNBEAT):
        raise DomainError(_DOWNBEAT_ERROR)
    return js_round(seconds * 10000) / 10000


def clean_selection(start: float, end: float, length: float) -> tuple[float, float]:
    """A selection kept inside a song ``length`` seconds long (``math.inf`` when that is not
    known), or a sentence that says why it cannot be one."""
    if not (math.isfinite(start) and math.isfinite(end)):
        raise DomainError("the selection must be a time in seconds")
    if end <= start:
        raise DomainError("the selection must end after it starts")
    start, end = min(max(start, 0.0), length), min(max(end, 0.0), length)
    if end - start < MIN_SELECTION:
        raise DomainError("the selection is too short")
    return start, end


@dataclass(frozen=True)
class SongPart:
    """A part of a song separated alone, as a song of its own: where it is, in seconds of
    the song, and its name as a clip of it is named ("bars 9-16"), which names its stems."""

    start: float
    end: float
    label: str

    def frames(self, rate: int) -> tuple[int, int]:
        """Its first frame in the song and its length, at ``rate``: the frames a clip of the
        same selection is cut from (`pipeline.clip`), so the two line up."""
        return round(self.start * rate), round((self.end - self.start) * rate)

    def to_dict(self) -> dict[str, Any]:
        return {"start": self.start, "end": self.end, "label": self.label}

    @staticmethod
    def from_dict(value: Any) -> SongPart | None:
        """A job's ``range`` option, or None for the whole song."""
        if value is None:
            return None
        try:
            return SongPart(float(value["start"]), float(value["end"]), str(value["label"]))
        except (KeyError, TypeError, ValueError):
            raise DomainError("the part of the song to separate cannot be read") from None


def part_downbeat(downbeat: float, start: float, bpm: float | None) -> float | None:
    """Where bar 1 of a song is in a part of it that starts at ``start``, both in seconds:
    on the song's own grid lines, moved into the part. A bar 1 in the part or after it
    stays where it is. One before the part moves on by whole bars to the part's first bar
    line, as detection would place it: a bar line less than half a beat before the part's
    start is bar 1, and a part that starts later in a bar begins with bar 0. Without a
    tempo it cannot move, so it is None, and detection finds the part's own."""
    moved = downbeat - start
    if bpm is None:
        return clean_downbeat(moved) if moved > -EPS else None
    beat = 60 / bpm
    if moved < -beat / 2:
        bar = beat * 4
        moved += math.ceil((-beat / 2 - moved) / bar) * bar
    return clean_downbeat(moved)


def make_grid(bpm: Any, downbeat: Any, beats_per_bar: Any = 4) -> Grid:
    """A grid from a request, checked but not rounded: a clip is named from the grid exactly
    as the app drew it, so both name it alike."""
    try:
        tempo, first = float(bpm), float(downbeat)
    except (TypeError, ValueError):
        raise DomainError("the grid needs a tempo and where bar 1 starts") from None
    if not (math.isfinite(tempo) and MIN_BPM <= tempo <= MAX_BPM):
        raise DomainError("the tempo must be between 20 and 999 BPM")
    if not (math.isfinite(first) and MIN_DOWNBEAT <= first <= MAX_DOWNBEAT):
        raise DomainError(_DOWNBEAT_ERROR)
    if isinstance(beats_per_bar, bool) or not isinstance(beats_per_bar, int):
        raise DomainError(f"a bar must have 1 to {MAX_BEATS_PER_BAR} beats")
    if not 1 <= beats_per_bar <= MAX_BEATS_PER_BAR:
        raise DomainError(f"a bar must have 1 to {MAX_BEATS_PER_BAR} beats")
    return Grid(tempo, first, beats_per_bar)
