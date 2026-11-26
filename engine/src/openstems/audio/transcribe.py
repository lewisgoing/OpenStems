"""The notes of a single-line stem (Phase 7, stage M3): a voice, a bass, a lead line.

How it works, in the order the code runs. Every figure is from the benchmark in
``scripts/midi_bench.py``; ``docs/research/stem-to-midi.md`` has the tables.

1. **Pitch per frame.** SwiftF0 (ONNX, on the CPU) gives a pitch and a confidence every
   16 ms. It hears nothing below 46.9 Hz, a bass's low E included, so a bass is tracked a
   second time at double speed, where every pitch is an octave up and inside its range; the
   frames that pass finds under 58 Hz replace the first pass's.
2. **Notes.** The frames are cut into notes and gaps by the dynamic program of SwiftF0's
   own segmenter, ported here so it can take one more piece of evidence: on a plucked line
   a note that is struck again while it sounds starts a new note there, where pitch alone
   would run the two together. A voice is never split this way: it did not help.
3. **Candidates.** A second, more willing pass finds notes the first one left out. They are
   kept, with a low confidence, for the "more notes" end of the editor's sensitivity.
4. **Starts.** A pitch takes a few periods to settle, so a bass note's start is moved back
   to where its sound begins. On a voice the start stays where the pitch starts.
5. **Per note:** a confidence (a small logistic model over what the note cost and how it
   sounds, fitted by ``scripts/midi_calibrate.py``), a velocity from its level, and its
   pitch curve.

No torch: numpy, librosa, soxr and onnxruntime, so the API process may call it.
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from openstems.domain.notes import Note, estimate_tuning, line_kind

RATE = 16000  # SwiftF0's sample rate
HOP = 256
FRAME_S = HOP / RATE  # 16 ms: one SwiftF0 frame
FLOOR_HZ = 46.875  # the lowest pitch SwiftF0 reports
LOW_BELOW_HZ = 58.0  # the double-speed pass is trusted for pitches under this
NOTE_COST = 5.0  # what a note must earn: 80 ms of frames (SwiftF0's default)
CANDIDATE_COST = 3.0  # the more willing pass: cheaper notes,
CANDIDATE_BIAS = 1.0  # and frames that count as a little more voiced than they scored
ONSET_COST = 10.0  # what carrying a note through a struck onset costs: two notes' worth
ENV_HOP = 64  # the level envelope's step: 4 ms
THREADS = 2  # SwiftF0 is small; more threads buy little and this machine shares its cores
# A stem is a single line when SwiftF0 is this sure of a pitch, on average, over its louder
# frames. Chords leave it unsure: GuitarSet's solos average 0.88 and its chord clips 0.60, and
# 0.78 tells 94 percent of the solos and 93 percent of the chord clips rightly (360 clips).
LINE_CLARITY = 0.78


@dataclass(frozen=True)
class Profile:
    """How one kind of stem is read."""

    name: str
    onsets: float | None  # how far an onset must stand out to split a held note; None: never
    superflux: bool  # the onset measure that ignores vibrato (bowed and plucked lines)
    snap: bool  # move each start back to the note's attack
    low: bool  # a second pass at double speed, for notes under SwiftF0's floor
    program: int  # General MIDI program for the stem's MIDI file
    # The pitches SwiftF0 is asked for, in Hz (None: its own limit). A separated stem holds a
    # little of the other parts, and without a range a bass gave the odd note three octaves up.
    lowest: float | None = None
    highest: float | None = None
    # The confidence model: weights for `_features`, fitted on the benchmark's clean stems
    # by scripts/midi_calibrate.py, and the confidence at or above which a note is shown.
    weights: tuple[float, ...] = ()
    threshold: float = 0.5


# Fitted by `scripts/midi_calibrate.py fit` on every other clip of each set (2026-11-25), and
# measured on the clips between: the figures in docs/research/stem-to-midi.md, section 14.
PROFILES = {
    "voice": Profile(
        "voice",
        onsets=None,
        superflux=True,
        snap=False,
        low=False,
        program=53,
        lowest=65.0,  # C2 to about C6
        highest=1100.0,
        weights=(
            1.0722,
            0.2869,
            -0.6253,
            -0.3026,
            1.1015,
            -1.702,
            -0.6398,
            -0.7566,
            -1.5878,
            0.0707,
            0.1393,
        ),
        threshold=0.42,
    ),
    "bass": Profile(
        "bass",
        onsets=2.0,
        superflux=False,
        snap=True,
        low=True,
        program=33,
        highest=800.0,  # every Slakh bass note lies under 784 Hz
        weights=(
            -7.4653,
            0.2182,
            0.2209,
            0.2643,
            0.0861,
            -3.8523,
            1.4008,
            -1.114,
            -0.0301,
            9.2843,
            12.2238,
        ),
        threshold=0.68,
    ),
    "line": Profile(
        "line",
        onsets=2.5,
        superflux=True,
        snap=True,
        low=False,
        program=0,
        weights=(
            1.5437,
            -0.2816,
            0.9475,
            1.3377,
            0.8386,
            -2.902,
            -0.5748,
            -0.4031,
            -2.7832,
            1.2124,
            3.9553,
        ),
        threshold=0.52,
    ),
}


@dataclass(frozen=True)
class Transcription:
    """Every note found in a stem, sure and unsure, in time order.

    A note at or above ``threshold`` is part of the transcription; the ones below are
    candidates, kept for an editor to offer. ``tuning_cents`` is the stem's own tuning and
    ``tuning_strength`` how tightly its notes agree on it (0 to 1). ``clarity`` is how sure
    SwiftF0 was of one pitch over the stem's louder frames: under ``LINE_CLARITY`` the stem
    plays chords, and what was found is one line of them.
    """

    notes: tuple[Note, ...] = ()
    threshold: float = 0.5
    tuning_cents: float = 0.0
    tuning_strength: float = 0.0
    profile: str = "line"
    clarity: float = 1.0
    features: tuple[tuple[float, ...], ...] = field(default=(), repr=False, compare=False)

    def shown(self) -> list[Note]:
        return [n for n in self.notes if (n.confidence or 0.0) >= self.threshold]

    @property
    def texture(self) -> str:
        """``line`` for one note at a time, ``chords`` for a stem with several."""
        return "line" if self.clarity >= LINE_CLARITY else "chords"


# -- pitch per frame ------------------------------------------------------------------------

_detector: Any = None
_detector_lock = threading.Lock()


def _swiftf0() -> Any:
    """One SwiftF0 session for the process. Its ``detect`` may be called from any thread."""
    global _detector
    with _detector_lock:
        if _detector is None:
            from swift_f0 import SwiftF0

            _detector = SwiftF0(threads=THREADS, spin=False)
        return _detector


def mono16(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Any audio, ``(channels, samples)`` or mono, as float32 mono at 16 kHz."""
    import soxr

    mono = audio.mean(axis=0) if audio.ndim == 2 else audio
    mono = np.ascontiguousarray(mono, dtype=np.float32)
    if sample_rate != RATE and mono.size:
        mono = soxr.resample(mono, sample_rate, RATE).astype(np.float32)
    return mono


@dataclass
class Frames:
    """SwiftF0's answer per 16 ms frame: pitch in semitones (0 where there is none), its
    confidence as a weight (0 where there is no pitch), and the level in dB."""

    m: np.ndarray
    w: np.ndarray
    level: np.ndarray

    @property
    def valid(self) -> np.ndarray:
        return self.w > 0


def _to_frames(pitch_hz: np.ndarray, confidence: np.ndarray, level: np.ndarray) -> Frames:
    valid = np.isfinite(pitch_hz) & (pitch_hz > 0)
    m = np.zeros(len(pitch_hz))
    m[valid] = 69.0 + 12.0 * np.log2(pitch_hz[valid] / 440.0)
    return Frames(m, np.where(valid, confidence, 0.0), np.asarray(level, dtype=np.float64))


def pitch_frames(audio16: np.ndarray, profile: Profile) -> Frames:
    """SwiftF0 over 16 kHz mono, within the profile's range. For a profile with ``low``, a
    second pass at double speed fills in what lies under SwiftF0's floor: at twice the speed
    a 41 Hz low E is an 82 Hz note."""
    detector = _swiftf0()
    first = detector.detect(audio16, RATE, fmin=profile.lowest, fmax=profile.highest)
    pitch, confidence = first.pitch_hz.copy(), first.confidence.copy()
    if profile.low and audio16.size >= 4 * HOP:
        import soxr

        top = None if profile.highest is None else min(2 * profile.highest, 2000.0)
        fast = detector.detect(
            soxr.resample(audio16, RATE, RATE // 2).astype(np.float32), RATE, fmax=top
        )
        n = len(pitch)
        # Each of its frames spans two of ours.
        up_pitch = np.zeros(n)
        up_conf = np.zeros(n)
        doubled = np.repeat(fast.pitch_hz / 2.0, 2)[:n]
        up_pitch[: len(doubled)] = doubled
        up_conf[: len(doubled)] = np.repeat(fast.confidence, 2)[:n]
        take = (up_conf >= 0.5) & (up_pitch > 0) & (up_pitch < LOW_BELOW_HZ)
        pitch[take] = up_pitch[take]
        confidence[take] = up_conf[take]
    return _to_frames(pitch, confidence, first.loudness_db)


# -- notes: SwiftF0's segmenter, with onsets ------------------------------------------------
#
# `_frame_cost` and `_segment` are a port of `segment_notes` from swift-f0 0.3.0
# (https://github.com/lars76/swift-f0), with the onset term and the bias added:
#
#   MIT License. Copyright (c) 2025-2026 Lars Nieradzik
#
#   Permission is hereby granted, free of charge, to any person obtaining a copy of this
#   software and associated documentation files (the "Software"), to deal in the Software
#   without restriction, including without limitation the rights to use, copy, modify, merge,
#   publish, distribute, sublicense, and/or sell copies of the Software, and to permit
#   persons to whom the Software is furnished to do so, subject to the following conditions:
#   The above copyright notice and this permission notice shall be included in all copies or
#   substantial portions of the Software.
#
#   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
#   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
#   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
#   FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
#   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
#   DEALINGS IN THE SOFTWARE.

Span = tuple[int, int, float]  # first frame, end frame (exclusive), pitch in semitones


def _frame_cost(frames: Frames) -> np.ndarray:
    """What it costs to hold a frame inside a note: unvoiced frames cost, voiced ones pay
    (the log odds of the confidence), and a frame in a dip of the level costs its depth."""
    n = len(frames.w)
    cc = np.clip(frames.w, 0.01, 0.99)
    padded = np.pad(frames.level, 4, mode="symmetric")
    left = np.maximum.reduce([padded[j : j + n] for j in range(5)])
    right = np.maximum.reduce([padded[4 + j : 4 + j + n] for j in range(5)])
    dip = np.maximum(0.0, np.minimum(left, right) - frames.level - 10 * np.log10(2.0))
    return -np.log(cc / (1.0 - cc)) + dip


def _segment(
    frames: Frames,
    cost: np.ndarray,
    note_cost: float = NOTE_COST,
    struck: np.ndarray | None = None,
    min_age: int = 4,
) -> list[Span]:
    """The cheapest way to cut the frames into notes and gaps, found exactly by dynamic
    programming. A note costs ``note_cost`` plus its frames' costs plus how far each frame's
    pitch lies from the note's (capped at 2 semitones, weighted by confidence); a gap costs
    nothing. ``struck`` marks frames where something was struck: a note at least ``min_age``
    frames old pays ``ONSET_COST`` to carry on through one, so it ends there instead."""
    m, w = frames.m, frames.w
    n = len(m)
    valid = frames.valid
    if not valid.any():
        return []
    mu = np.unique(np.floor(m[valid] * 100 + 0.5) / 100)
    open_cost = np.full(len(mu), np.inf)  # the best cost so far with a note open at each pitch
    opened = np.zeros(len(mu), dtype=np.intp)
    back = np.zeros(n + 1, dtype=np.intp)
    kind = np.full(n + 1, -1, dtype=np.intp)
    work = np.empty(len(mu))
    best = 0.0
    for t in range(n):
        if struck is not None and struck[t]:
            open_cost += ONSET_COST * ((t - opened) >= min_age)
        start = best + note_cost
        new = start < open_cost
        opened[new] = t
        np.minimum(open_cost, start, out=open_cost)
        np.subtract(mu, m[t], out=work)
        np.abs(work, out=work)
        np.minimum(work, 2.0, out=work)
        work *= w[t]
        work += cost[t]
        open_cost += work
        j = int(np.argmin(open_cost))
        if open_cost[j] < best:
            best = float(open_cost[j])
            back[t + 1] = opened[j]
            kind[t + 1] = j
        else:
            back[t + 1] = t
    spans: list[Span] = []
    b = n
    while b > 0:
        a = int(back[b])
        if kind[b] >= 0:
            spans.append((a, b, float(mu[kind[b]])))
        b = a
    spans.reverse()
    return spans


def _outside(default: list[Span], relaxed: list[Span], most: float = 0.3) -> list[Span]:
    """The relaxed pass's notes that lie where the default pass found nothing: at most
    ``most`` of each under a default note. Those are trimmed to the gap they sit in."""
    out: list[Span] = []
    j = 0
    for a, b, mu in relaxed:
        while j < len(default) and default[j][1] <= a:
            j += 1
        covered = 0
        k = j
        lo, hi = a, b
        while k < len(default) and default[k][0] < b:
            da, db = default[k][0], default[k][1]
            covered += min(b, db) - max(a, da)
            # keep the larger free side of the overlap
            if da <= lo < db:
                lo = db
            elif lo < da < hi:
                hi = da
            k += 1
        if covered <= most * (b - a) and hi - lo >= 2:
            out.append((lo, hi, mu))
    return out


# -- onsets and attacks ---------------------------------------------------------------------


def onset_strength(audio16: np.ndarray, n_frames: int, superflux: bool) -> np.ndarray:
    """How much new sound each 16 ms frame brings: spectral flux on a mel scale, taken every
    8 ms and kept as the larger of each frame's two steps. ``superflux`` (Boeck and Widmer,
    2013) compares against a maximum over neighbouring bands, so vibrato does not count."""
    import librosa

    extra: dict[str, Any] = {"lag": 2, "max_size": 3} if superflux else {}
    env = librosa.onset.onset_strength(
        y=audio16,
        sr=RATE,
        hop_length=HOP // 2,
        n_fft=1024,
        n_mels=96,
        fmin=27.5,
        fmax=8000,
        **extra,
    )
    env = env[: 2 * (len(env) // 2)].reshape(-1, 2).max(axis=1)
    out = np.zeros(n_frames)
    out[: min(n_frames, len(env))] = env[:n_frames]
    return out


def onset_peaks(strength: np.ndarray, delta: float, wait: int = 3) -> np.ndarray:
    """True at frames where the strength peaks (the largest within 32 ms each way) at least
    ``delta`` above its mean over 96 ms each way, no two closer than ``wait`` frames."""
    n = len(strength)
    pad = np.pad(strength, 6, mode="edge")
    local = np.mean([pad[j : j + n] for j in range(13)], axis=0)
    highest = np.maximum.reduce([pad[4 + j : 4 + j + n] for j in range(5)])
    peak = (strength >= highest) & (strength - local >= delta)
    out = np.zeros(n, dtype=bool)
    last = -wait
    for t in np.flatnonzero(peak):
        if t - last >= wait:
            out[t] = True
            last = int(t)
    return out


def envelope_db(audio16: np.ndarray) -> np.ndarray:
    """The RMS level in dB every 4 ms, over the 16 ms around each step."""
    n = len(audio16) // ENV_HOP
    if n == 0:
        return np.zeros(0)
    power = np.square(audio16[: n * ENV_HOP].astype(np.float64)).reshape(n, ENV_HOP).sum(axis=1)
    total = np.concatenate([[0.0], np.cumsum(power)])
    at = np.arange(n)
    lo, hi = np.maximum(at - 2, 0), np.minimum(at + 2, n)
    return 10 * np.log10(np.maximum((total[hi] - total[lo]) / ((hi - lo) * ENV_HOP), 1e-12))


def attack(
    env: np.ndarray, start: float, back: float = 0.10, ahead: float = 0.02
) -> tuple[float, float] | None:
    """Where the level rises fastest within ``back`` seconds before a note's start (the
    moment it was struck) and by how many dB over 12 ms. None without a rise of 3 dB."""
    step = ENV_HOP / RATE
    a = max(0, round((start - back) / step))
    b = min(len(env) - 1, round((start + ahead) / step))
    if b - a < 4:
        return None
    part = env[a : b + 1]
    rise = part[3:] - part[:-3]
    k = int(np.argmax(rise))
    if rise[k] < 3.0:
        return None
    return (a + k + 1.5) * step, float(rise[k])


# -- one note's numbers ---------------------------------------------------------------------

FEATURES = (
    *("evidence", "per_frame", "log_seconds", "voiced", "spread", "level", "candidate"),
    *("outlier", "gap", "velocity"),
)
CANDIDATE = FEATURES.index("candidate")


def _features(
    span: Span, frames: Frames, cost: np.ndarray, top_level: float, candidate: bool
) -> tuple[float, ...]:
    """What the confidence model sees of one note (`FEATURES` names them):

    - evidence: how much its frames paid toward a note's cost, capped at 60;
    - per_frame: the same per frame;
    - log_seconds: the log of its length;
    - voiced: the share of its frames SwiftF0 calls voiced;
    - spread: how far, on average, its frames' pitch lies from the note's (semitones);
    - level: its loudest frame, in dB under the stem's loud frames (capped at 40);
    - candidate: 1 when only the more willing pass found it.

    `_context` adds the three that need the notes around it.
    """
    a, b, mu = span
    w = frames.w[a:b]
    off = np.minimum(np.abs(frames.m[a:b] - mu), 2.0)
    paid = float(np.sum(-cost[a:b] - w * off))
    total = float(w.sum())
    spread = float(np.sum(w * off) / total) if total > 0 else 2.0
    level = float(min(40.0, max(0.0, top_level - frames.level[a:b].max())))
    return (
        min(paid, 60.0) / 10.0,
        paid / (b - a) / 2.0,
        math.log((b - a) * FRAME_S),
        float(np.mean(w >= 0.5)),
        spread,
        level / 10.0,
        1.0 if candidate else 0.0,
    )


def _context(
    pitches: list[float], times: list[list[float]], velocities: list[int]
) -> list[tuple[float, ...]]:
    """Per note, what its neighbours say of it:

    - outlier: how far its pitch lies from the median of the three notes each side, in
      octaves, capped at one;
    - gap: the silence before it, in seconds, capped at one;
    - velocity: its loudness, 0 to 1.
    """
    out = []
    n = len(pitches)
    for i in range(n):
        near = pitches[max(0, i - 3) : i] + pitches[i + 1 : i + 4]
        outlier = min(abs(pitches[i] - float(np.median(near))), 12.0) / 12.0 if near else 0.0
        gap = min(max(times[i][0] - times[i - 1][1], 0.0), 1.0) if i else 1.0
        out.append((outlier, gap, velocities[i] / 127.0))
    return out


def _confidence(features: tuple[float, ...], profile: Profile) -> float:
    if not profile.weights:  # not fitted yet: the default pass's notes above the candidates
        return 0.4 if features[CANDIDATE] else 0.8
    z = profile.weights[0] + sum(w * x for w, x in zip(profile.weights[1:], features, strict=True))
    return 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))


def _velocity(level_db: float, top_db: float) -> int:
    """A note's loudest 16 ms against the stem's loud notes: 6 dB quieter is about 20 lower."""
    return int(min(127, max(1, round(110 + (level_db - top_db) * 3.3))))


def _curve(span: Span, frames: Frames, start: float, end: float) -> tuple[tuple[float, float], ...]:
    """The note's pitch against its own, as (seconds from its start, semitones) steps: a
    3-frame median of the voiced frames, a new point where it has moved 5 cents. Empty for a
    note that stays within 10 cents. ``start`` and ``end`` are the note's final times, which
    may differ from its frames' by a moved start or a trimmed end."""
    a, b, mu = span
    w = frames.w[a:b]
    if b - a < 3 or not (w >= 0.5).any():
        return ()
    dev = np.where(w >= 0.5, frames.m[a:b] - mu, np.nan)
    # hold the last voiced value through unvoiced frames, the first one back to the start
    idx = np.where(np.isnan(dev), 0, np.arange(len(dev)))
    np.maximum.accumulate(idx, out=idx)
    dev = dev[idx]
    first = int(np.flatnonzero(w >= 0.5)[0])
    dev[:first] = dev[first]
    pad = np.pad(dev, 1, mode="edge")
    dev = np.clip(np.median(np.stack([pad[:-2], pad[1:-1], pad[2:]]), axis=0), -2.0, 2.0)
    if float(np.abs(dev).max()) < 0.10:
        return ()
    points: list[tuple[float, float]] = []
    last = None
    for i, value in enumerate(dev):
        at = round(max(0.0, (a + i) * FRAME_S - start), 4)
        if at >= end - start:
            break
        if last is not None and abs(value - last) < 0.05:
            continue
        last = float(value)
        if points and points[-1][0] == at:  # frames before a start that moved: keep the last
            points[-1] = (at, round(last, 3))
        else:
            points.append((at, round(last, 3)))
    return tuple(points)


# -- the whole stem -------------------------------------------------------------------------


def transcribe_line(audio: np.ndarray, sample_rate: int, stem: str = "") -> Transcription:
    """The notes of a stem that plays one note at a time. ``stem`` is its name in the recipe
    (``vocals``, ``bass``, ...): it picks the profile. A stem with chords gives its most
    prominent line."""
    profile = PROFILES[line_kind(stem) or "line"]
    audio16 = mono16(audio, sample_rate)
    if audio16.size < RATE // 4 or float(np.abs(audio16).max()) < 1e-4:
        return Transcription(profile=profile.name, threshold=profile.threshold)
    frames = pitch_frames(audio16, profile)
    if not frames.valid.any():
        return Transcription(profile=profile.name, threshold=profile.threshold)
    cost = _frame_cost(frames)
    struck = None
    if profile.onsets is not None:
        strength = onset_strength(audio16, len(frames.m), profile.superflux)
        struck = onset_peaks(strength, profile.onsets)
    default = _segment(frames, cost, NOTE_COST, struck)
    relaxed = _segment(frames, cost - CANDIDATE_BIAS, CANDIDATE_COST, struck)
    spans = sorted([(s, False) for s in default] + [(s, True) for s in _outside(default, relaxed)])
    if not spans:
        return Transcription(profile=profile.name, threshold=profile.threshold)

    env = envelope_db(audio16)
    step = ENV_HOP / RATE
    voiced_level = frames.level[frames.w >= 0.5]
    top_level = float(np.percentile(voiced_level, 95)) if voiced_level.size else 0.0
    # Starts and ends in seconds. A start may move back to the attack, never past the note
    # before it; that note then ends where this one starts.
    times: list[list[float]] = []
    for (a, b, _), candidate in spans:
        start, end = a * FRAME_S, b * FRAME_S
        if profile.snap:
            found = attack(env, start)
            floor = times[-1][0] + 0.03 if times else 0.0
            if found is not None and floor <= found[0] < end - 0.03:
                start = found[0]
        if times and times[-1][1] > start:
            if candidate:  # a candidate never shortens the note before it
                start = times[-1][1]
            else:
                times[-1][1] = start
        times.append([start, end])
    peaks = []
    for start, end in times:
        lo, hi = (
            round(start / step),
            max(round(start / step) + 1, round(min(end, start + 0.15) / step)),
        )
        peaks.append(float(env[lo:hi].max()) if lo < len(env) else -120.0)
    shown_peaks = [p for p, (_, candidate) in zip(peaks, spans, strict=True) if not candidate]
    top_peak = float(np.percentile(shown_peaks or peaks, 90))

    # Notes cut down to nothing by a neighbour's moved start are dropped before anything
    # is said about their neighbours.
    kept = [i for i, (start, end) in enumerate(times) if round(end, 4) - round(start, 4) >= 0.02]
    spans = [spans[i] for i in kept]
    times = [[round(times[i][0], 4), round(times[i][1], 4)] for i in kept]
    velocities = [_velocity(peaks[i], top_peak) for i in kept]
    context = _context([span[2] for span, _ in spans], times, velocities)
    notes: list[Note] = []
    features: list[tuple[float, ...]] = []
    for (span, candidate), (start, end), velocity, around in zip(
        spans, times, velocities, context, strict=True
    ):
        x = (*_features(span, frames, cost, top_level, candidate), *around)
        notes.append(
            Note(
                start=start,
                end=end,
                pitch=min(127.0, max(0.0, span[2])),
                velocity=velocity,
                confidence=round(_confidence(x, profile), 3),
                bend=_curve(span, frames, start, end),
            )
        )
        features.append(x)
    sure = [n for n in notes if (n.confidence or 0.0) >= profile.threshold] or notes
    weights = [n.duration for n in sure]
    cents = estimate_tuning([n.pitch for n in sure], weights)
    loud = frames.level > np.percentile(frames.level, 60)
    return Transcription(
        notes=tuple(notes),
        threshold=profile.threshold,
        tuning_cents=round(cents, 1),
        tuning_strength=round(tuning_strength([n.pitch for n in sure], weights), 3),
        profile=profile.name,
        clarity=round(float(frames.w[loud].mean()), 3) if loud.any() else 1.0,
        features=tuple(features),
    )


def tuning_strength(pitches: list[float], weights: list[float]) -> float:
    """How tightly notes agree on one tuning, 0 to 1: the length of the mean of their
    fractional pitches as points on a circle. Notes all 20 cents sharp give 1; notes spread
    evenly between the keys give 0."""
    total = sum(weights)
    if total <= 0:
        return 0.0
    x = sum(w * math.cos(2 * math.pi * p) for p, w in zip(pitches, weights, strict=True))
    y = sum(w * math.sin(2 * math.pi * p) for p, w in zip(pitches, weights, strict=True))
    return math.hypot(x, y) / total
