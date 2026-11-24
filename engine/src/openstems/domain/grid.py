"""A song's beat grid, and a stretch of the song named in a few words.

Everything is in seconds of the song's own timeline, which the source file and every stem
share. The app keeps a twin of these functions in TypeScript: the same arithmetic in the
same order, so that both name a selection alike, digit for digit. JavaScript's
``Math.round`` sends a half up (2.5 is 3), where Python's ``round`` sends it to the even
number, so `js_round` stands in for it here.
"""

from __future__ import annotations

import math
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

_DOWNBEAT_ERROR = "bar 1 must be a time in seconds"


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
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        raise DomainError(_DOWNBEAT_ERROR) from None
    if not (math.isfinite(seconds) and MIN_DOWNBEAT <= seconds <= MAX_DOWNBEAT):
        raise DomainError(_DOWNBEAT_ERROR)
    return js_round(seconds * 10000) / 10000


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
