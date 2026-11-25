"""Which stems of a song are empty.

A separation always writes every stem its recipe names, so a rap song still gets a guitar
and a piano. Those hold only what the model let through: a hiss far under the song. The
rule here says which stems are that, from each stem's peak (its largest sample, linear).

A stem is empty when its peak is more than ``EMPTY_BELOW_DB`` under the loudest stem of its
set. The measure is relative, so a quiet recording keeps its quiet parts. A stem whose peak
is not known is never called empty. `docs/adr/0027-empty-stems.md` has the figures the
threshold was read from.
"""

from __future__ import annotations

from collections.abc import Hashable, Mapping

# How far under the loudest stem a stem's peak must stay to count as empty, in dB.
EMPTY_BELOW_DB = 45.0


def empty_stems[Name: Hashable](peaks: Mapping[Name, float | None]) -> set[Name]:
    """The names in ``peaks`` whose stems are empty. Every stem of one set must be given,
    since each is judged against the loudest. A set of nothing but silence is all empty."""
    known = {name: abs(peak) for name, peak in peaks.items() if peak is not None}
    loudest = max(known.values(), default=0.0)
    limit = loudest * 10 ** (-EMPTY_BELOW_DB / 20)
    return {name for name, peak in known.items() if peak <= 0.0 or peak < limit}
