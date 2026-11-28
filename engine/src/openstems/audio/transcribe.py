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
   would run the two together. Struck means an onset in the spectrum with a rise in the
   stem's own level: bleed from a drum has the first without the second. A voice is never
   split this way: it did not help.
3. **Candidates.** A second, more willing pass finds notes the first one left out. They are
   kept, with a low confidence, for the "more notes" end of the editor's sensitivity.
4. **Starts.** A pitch takes a few periods to settle, so on a bass or any plucked line a
   note's start is moved back to where its sound begins (worth 6 points of F1 on bass, next
   to nothing on guitar). On a voice the start stays where the pitch starts.
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
# SwiftF0 reports no pitch under 46.875 Hz. The double-speed pass is trusted for pitches
# under this: 58 scored best on the slowed bass set, against 70, 85 and 110.
LOW_BELOW_HZ = 58.0
NOTE_COST = 5.0  # what a note must earn: 80 ms of frames (SwiftF0's default)
CANDIDATE_COST = 3.0  # the more willing pass: cheaper notes,
CANDIDATE_BIAS = 1.0  # and frames that count as a little more voiced than they scored
# What carrying a note through a struck onset costs. It is more than a new note costs, so
# the cheapest path always starts one there: any figure above NOTE_COST gives the same notes.
ONSET_COST = 10.0
# Every stem is read at this peak level. SwiftF0 calls a frame under a fixed level silent, so
# a quiet stem lost notes: read at a peak of 0.01, a guitar solo agreed with its own notes at
# its own level by only 0.62 to 0.90 (onset F1), and at 0.003 by under a third. Which level
# hardly matters on clean recordings (0.25, 0.35 and 0.5 score within 0.003 of each other on
# all three sets); 0.35 is near where the benchmark's own stems peak.
LEVEL = 0.35
PEAK_SAMPLES = 32  # a stem's peak is its 32nd largest sample (2 ms): no click sets its level
LIMIT = 4.0  # a sample further from zero than this is a defect in the file, not sound
ENV_HOP = 64  # the level envelope's step: 4 ms
THREADS = 2  # SwiftF0 is small; more threads buy little and this machine shares its cores
# A stem is a single line when SwiftF0 is this sure of a pitch, on average, over its louder
# frames (`clarity`). Chords leave it unsure: GuitarSet's solos average 0.89 and its chord
# clips 0.59, and 0.80 tells 95 percent of each rightly (360 clips, and the figure was chosen
# on them). Every vocal clip and 141 of 142 bass stems read as a line.
LINE_CLARITY = 0.80
# A pure tone is read from its spectrum. SwiftF0 was trained on sounds with harmonics, and of
# a clean sub-bass or a clean 808 it is unsure: of eleven sine notes from B0 to E4 it showed
# 9 held and 7 dying away, none of them under its floor, and of eight notes of 110 ms none.
# But a lone sine is the one sound whose pitch the peak of a spectrum tells beyond doubt, at
# any pitch. So in a stem that is mostly pure tone, a frame in which SwiftF0 hears no pitch
# takes the frequency of its one partial (`with_pure_tones`).
#
# Only in such a stem. A kick drum's low tail is the same sound as an 808, and where one
# leaked into a bass that has harmonics it must stay unheard: read frame by frame wherever a
# frame was pure, a kick as loud as the bass, between its notes, came out as a note each
# time. And on the benchmark's real basses the fill, let loose on every stem, cost 0.0025
# with the rest of the song 15 dB under them (onset F1); kept to stems that are mostly pure
# tone it changed none of the 142, alone or under their songs.
TONE_WINDOW = 2048  # 128 ms of 16 kHz: four periods of a 5-string's low B
TONE_FFT = 4096  # padded: bins of 4 Hz, set finer by the shape of the peak
TONE_RANGE = (25.0, 400.0)  # Hz: where a frame's partial is looked for
TONE_TOP = 4000.0  # Hz: a frame's energy is counted up to here
TONE_PURE = 0.95  # of that energy, the share in the one partial: all else 13 dB under it
TONE_LOUD = 0.01  # a frame's RMS, of a stem read at LEVEL: a quieter frame is not asked
TONE_SHARE = 0.5  # of a stem's loud frames, the share that must be pure for any to be taken
TONE_CONFIDENCE = 0.95  # what a pure frame's pitch weighs, as SwiftF0's surest frames do
TONE_EDGE = 4  # frames either side of a pure one that are its note's own start or end: 64 ms


@dataclass(frozen=True)
class Profile:
    """How one kind of stem is read."""

    name: str
    onsets: float | None  # how far an onset must stand out to split a held note; None: never
    superflux: bool  # the onset measure that ignores vibrato (bowed and plucked lines)
    snap: bool  # move each start back to the note's attack
    low: bool  # a second pass at double speed, for notes under SwiftF0's floor
    program: int  # General MIDI program for the stem's MIDI file
    # The confidence model: weights for `_features` and `_context`, and the confidence at or
    # above which a note is shown.
    weights: tuple[float, ...]
    threshold: float
    # The pitches SwiftF0 is asked for, in Hz (None: its own limit). A separated stem holds a
    # little of the other parts, and without a range a bass gave the odd note three octaves up.
    lowest: float | None = None
    highest: float | None = None


# Weights and thresholds: `scripts/midi_calibrate.py fit` on every other clip of each set
# (2026-11-25, never typed by hand), measured on the clips between. The figures are in
# docs/research/stem-to-midi.md, section 14.
# fmt: off
PROFILES = {
    "voice": Profile(
        "voice", onsets=None, superflux=True, snap=False, low=False, program=53,
        lowest=65.0, highest=1100.0,  # C2 to about C6
        weights=(-0.6538, 0.2574, -0.2218, -0.1985, 2.0674, -0.6389,
                 -1.1449, -0.4468, -1.8233, 0.4748, 0.5008),
        threshold=0.27,
    ),
    # A bass's onsets were 2.0 until 2026-11-27. A separator takes a bass stem's highs
    # away, and the onset strength is a mean over all 96 mel bands: at a soft second strike a
    # separated bass then showed 0.2 to 1.5 where its clean recording showed 2.0 to 4.5, and
    # 12 of one excerpt's 43 notes ran into the note before. At 1.0, 6 of those 12 are found
    # (five separated excerpts 0.945 to 0.962), clean basses read 0.954 for 0.947 and under
    # 25 dB of bleed 0.951 for 0.941 (development half). At 0.5, 9 of the 12, but real held
    # subs were cut a third more often. The rise of 3 dB in the level is still asked.
    "bass": Profile(
        "bass", onsets=1.0, superflux=False, snap=True, low=True, program=33,
        highest=800.0,  # every Slakh bass note lies under 784 Hz
        weights=(-8.9177, 0.0474, 1.0425, -0.0413, 0.0701, -2.3077,
                 0.7649, -0.4573, -1.0507, 0.4982, 13.7831),
        threshold=0.55,
    ),
    "line": Profile(
        "line", onsets=2.5, superflux=True, snap=True, low=False, program=0,
        weights=(1.0593, -0.0995, 1.0066, 0.8976, 0.9212, -3.0562,
                 -0.8650, -0.1692, -3.1175, 0.5150, 3.3176),
        threshold=0.45,
    ),
}
# fmt: on


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


def mono16(audio: np.ndarray, sample_rate: int, rate: int = RATE) -> np.ndarray:
    """Any audio, ``(channels, samples)`` or mono, as float32 mono at 16 kHz (or at ``rate``).
    A sample that is not a number, or lies far outside full scale, is a defect in the file (a
    decoder's answer to one, or a model's): it counts as silence, where SwiftF0 would refuse
    the stem."""
    import soxr

    audio = np.asarray(audio)
    if np.issubdtype(audio.dtype, np.integer):  # PCM as it is stored: full scale becomes 1
        half = 2.0 ** (8 * audio.dtype.itemsize - 1)
        middle = 0.0 if np.issubdtype(audio.dtype, np.signedinteger) else half
        audio = ((audio.astype(np.float64) - middle) / half).astype(np.float32)
    if audio.ndim == 2:
        # Channel by channel, each divided first: two samples at float32's largest value
        # would overflow in a sum.
        mono = np.zeros(audio.shape[1], dtype=np.float32)
        for channel in audio:
            mono += channel.astype(np.float32, copy=False) / np.float32(len(audio))
    else:
        mono = np.array(audio, dtype=np.float32)
    np.nan_to_num(mono, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    mono[np.abs(mono) > LIMIT] = 0.0
    if sample_rate != rate and mono.size:
        mono = soxr.resample(mono, sample_rate, rate).astype(np.float32)
    return mono


def peak_level(audio16: np.ndarray) -> float:
    """A stem's peak: its ``PEAK_SAMPLES``-th largest sample, so that a click or a few bad
    samples do not decide how loud the rest is read. Silence between phrases does not move
    it either. 0 for no audio."""
    n = min(PEAK_SAMPLES, audio16.size)
    return float(np.partition(np.abs(audio16), -n)[-n]) if n else 0.0


@dataclass
class Frames:
    """SwiftF0's answer per 16 ms frame: pitch in semitones (0 where there is none), its
    confidence as a weight (0 where there is no pitch, and where SwiftF0 calls the frame
    silent: it keeps a pitch there), and the level in dB. In a stem that is mostly pure
    tone, a frame SwiftF0 heard no pitch in holds the tone's own (`with_pure_tones`)."""

    m: np.ndarray
    w: np.ndarray
    level: np.ndarray
    # In a stem that is mostly pure tone: which frames are a pure tone. None in any other.
    pure: np.ndarray | None = None

    @property
    def valid(self) -> np.ndarray:
        """Frames with a pitch, as SwiftF0's segmenter counts them: a silent frame's pitch
        is one a note may take, though the frame itself weighs nothing."""
        return self.m > 0


def _to_frames(pitch_hz: np.ndarray, confidence: np.ndarray, level: np.ndarray) -> Frames:
    valid = np.isfinite(pitch_hz) & (pitch_hz > 0)
    m = np.zeros(len(pitch_hz))
    m[valid] = 69.0 + 12.0 * np.log2(pitch_hz[valid] / 440.0)
    # One number that is not finite would poison every cost after it in the segmenter.
    w = np.where(valid & np.isfinite(confidence), confidence, 0.0)
    floor = -140.0  # SwiftF0's own floor for the level
    level = np.nan_to_num(np.asarray(level, dtype=np.float64), nan=floor, neginf=floor, posinf=0.0)
    return Frames(m, w, level)


def pitch_frames(audio16: np.ndarray, profile: Profile) -> Frames:
    """The pitch of every frame of 16 kHz mono, 16 ms apart: SwiftF0's (`swift_frames`), and
    for a profile with ``low`` the pitch of a pure tone where SwiftF0 heard none
    (`with_pure_tones`)."""
    frames = swift_frames(audio16, profile)
    return with_pure_tones(frames, audio16) if profile.low else frames


def swift_frames(audio16: np.ndarray, profile: Profile) -> Frames:
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


def pure_tones(audio16: np.ndarray, frames: int) -> tuple[np.ndarray, np.ndarray]:
    """For each of ``frames`` frames 16 ms apart, as SwiftF0's are: the frequency in Hz of
    the frame's one partial if the frame is a pure tone, else 0; and whether the frame is
    loud enough to be asked at all (`TONE_LOUD`). A pure tone has `TONE_PURE` of its energy
    up to `TONE_TOP` in its strongest partial within `TONE_RANGE`."""
    tone = np.zeros(frames)
    if frames <= 0:
        return tone, np.zeros(0, dtype=bool)
    need = (frames - 1) * HOP + TONE_WINDOW
    x = np.zeros(max(need, audio16.size + TONE_WINDOW), dtype=np.float64)
    x[TONE_WINDOW // 2 : TONE_WINDOW // 2 + audio16.size] = audio16  # frame i is centred on i * HOP
    total = np.concatenate([[0.0], np.cumsum(x * x)])
    starts = np.arange(frames) * HOP
    loud = np.sqrt((total[starts + TONE_WINDOW] - total[starts]) / TONE_WINDOW) >= TONE_LOUD
    step = RATE / TONE_FFT
    low, high = (int(v / step) for v in TONE_RANGE)
    low, top = max(low, 2), int(TONE_TOP / step)
    half = max(2, round(2.5 * TONE_FFT / TONE_WINDOW))  # past the window's main lobe
    # Single precision from here: it is the spectrum's shape that is asked, and a long
    # stem has tens of thousands of frames.
    window = np.hanning(TONE_WINDOW).astype(np.float32)
    single = x.astype(np.float32)
    asked = np.flatnonzero(loud)
    for at in range(0, asked.size, 256):
        some = asked[at : at + 256]
        rows = np.arange(some.size)
        block = single[starts[some, None] + np.arange(TONE_WINDOW)] * window
        power = np.abs(np.fft.rfft(block, TONE_FFT, axis=1)[:, : top + 1]) ** 2
        peak = low + np.argmax(power[:, low:high], axis=1)
        summed = np.concatenate([np.zeros((some.size, 1)), np.cumsum(power, axis=1)], axis=1)
        inside = (
            summed[rows, np.minimum(peak + half + 1, top)]
            - summed[rows, np.maximum(peak - half, 1)]
        )
        pure = inside >= TONE_PURE * np.maximum(summed[rows, top] - summed[rows, 1], 1e-30)
        # The peak lies between two bins: a parabola through it and its neighbours says where.
        a, b, c = (np.log(power[rows, peak + k] + 1e-30) for k in (-1, 0, 1))
        bend = a - 2.0 * b + c
        off = np.where(bend < 0, 0.5 * (a - c) / np.where(bend < 0, bend, -1.0), 0.0)
        tone[some] = np.where(pure, (peak + np.clip(off, -0.5, 0.5)) * step, 0.0)
    return tone, loud


def with_pure_tones(frames: Frames, audio16: np.ndarray) -> Frames:
    """``frames`` with a pure tone's own pitch where SwiftF0 heard none, if the stem is
    mostly pure tone (`TONE_SHARE` of its loud frames): a clean sub-bass, a clean 808. Any
    other stem's frames are returned as they are."""
    tone, loud = pure_tones(audio16, len(frames.w))
    pure = tone > 0
    if not pure.any() or pure.sum() < TONE_SHARE * loud.sum():
        return frames
    # Only where SwiftF0 heard none: where it is sure, its pitch stands. It hears the note
    # of a sound whose fundamental is weak, which a spectrum's peak would put an octave up.
    take = pure & (frames.w < 0.5)
    m, w = frames.m.copy(), frames.w.copy()
    m[take] = 69.0 + 12.0 * np.log2(tone[take] / 440.0)
    w[take] = TONE_CONFIDENCE
    return Frames(m, w, frames.level, pure)


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
    frames old pays ``ONSET_COST`` to carry on through one. That is more than a new note
    costs, so it always ends there and a new one starts; a younger note carries on (the
    strike is its own, heard a little late)."""
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
    ``most`` of each under default notes. Each is cut back to the longest stretch of it
    that no default note covers."""
    out: list[Span] = []
    j = 0
    for a, b, mu in relaxed:
        while j < len(default) and default[j][1] <= a:
            j += 1
        covered = 0
        lo, hi = a, a  # the longest free stretch so far
        at = a  # where the next free stretch would start
        k = j
        while k < len(default) and default[k][0] < b:
            da, db = default[k][0], default[k][1]
            covered += min(b, db) - max(a, da)
            if da - at > hi - lo:
                lo, hi = at, da
            at = max(at, db)
            k += 1
        if b - at > hi - lo:
            lo, hi = at, b
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


def struck_again(peaks: np.ndarray, env: np.ndarray) -> np.ndarray:
    """The onset peaks at which the stem's own level rises as well, by 3 dB or more
    (`attack`, from 60 ms before the peak to 30 ms after): a string that is struck.

    An onset in the spectrum without that rise is something else's. A drum that bled into
    the stem makes one with every hit, and under a held note it barely moves the level.
    Cutting notes at those was most of what went wrong on a bass with the rest of its song
    under it. With the rest 25 dB under the bass, ending notes at any onset scored
    0.81 and asking for the rise as well 0.85; on clean stems 0.880 and 0.883, and
    on clean guitar solos 0.834 and 0.839 (the first pass's notes on the development half,
    before starts are moved).
    """
    out = peaks.copy()
    for t in np.flatnonzero(peaks):
        if attack(env, t * FRAME_S, back=0.06, ahead=0.03) is None:
            out[t] = False
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
    peak = peak_level(audio16)
    if audio16.size < RATE // 4 or peak < 1e-4:
        return Transcription(profile=profile.name, threshold=profile.threshold)
    audio16 = audio16 * np.float32(LEVEL / peak)  # the notes do not depend on a stem's gain
    frames = pitch_frames(audio16, profile)
    if not frames.valid.any():
        return Transcription(profile=profile.name, threshold=profile.threshold)
    cost = _frame_cost(frames)
    env = envelope_db(audio16)
    struck = None
    if profile.onsets is not None:
        strength = onset_strength(audio16, len(frames.m), profile.superflux)
        struck = struck_again(onset_peaks(strength, profile.onsets), env)
    default = _segment(frames, cost, NOTE_COST, struck)
    relaxed = _segment(frames, cost - CANDIDATE_BIAS, CANDIDATE_COST, struck)
    spans, times = _placed(default, _outside(default, relaxed), env, profile.snap)
    if not spans:
        return Transcription(profile=profile.name, threshold=profile.threshold)

    step = ENV_HOP / RATE
    voiced_level = frames.level[frames.w >= 0.5]
    top_level = float(np.percentile(voiced_level, 95)) if voiced_level.size else 0.0
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
    return Transcription(
        notes=tuple(notes),
        threshold=profile.threshold,
        tuning_cents=round(cents, 1),
        tuning_strength=round(tuning_strength([n.pitch for n in sure], weights), 3),
        profile=profile.name,
        clarity=round(clarity(frames), 3),
        features=tuple(features),
    )


def _placed(
    default: list[Span], candidates: list[Span], env: np.ndarray, snap: bool
) -> tuple[list[tuple[Span, bool]], list[list[float]]]:
    """Every note in time order, each with whether it is a candidate, and its start and end
    in seconds.

    With ``snap`` a start moves back to the note's attack, never to within 30 ms of the
    start of the note before it, and that note then ends where this one starts. The default
    pass's notes are placed first, among themselves: a candidate never moves one of them. It
    takes what is left of the gap it lies in, between the notes placed around it.
    """
    placed: list[list[float]] = []
    for a, b, _ in default:
        start, end = a * FRAME_S, b * FRAME_S
        if snap:
            found = attack(env, start)
            floor = placed[-1][0] + 0.03 if placed else 0.0
            if found is not None and floor <= found[0] < end - 0.03:
                start = found[0]
        if placed and placed[-1][1] > start:
            placed[-1][1] = start
        placed.append([start, end])
    order = sorted(
        [(span, False, at) for span, at in zip(default, placed, strict=True)]
        + [(span, True, [span[0] * FRAME_S, span[1] * FRAME_S]) for span in candidates],
        key=lambda item: item[0][0],
    )
    ahead = math.inf  # where the next default note starts, for each note from the last back
    limits = []
    for _, candidate, at in reversed(order):
        limits.append(ahead)
        if not candidate:
            ahead = at[0]
    limits.reverse()
    behind = 0.0  # where the note before ends
    for (_, candidate, at), limit in zip(order, limits, strict=True):
        if candidate:
            if snap:
                found = attack(env, at[0])
                if found is not None and behind <= found[0] < at[1] - 0.03:
                    at[0] = found[0]
            at[0] = max(at[0], behind)
            at[1] = min(at[1], limit)
        behind = max(behind, at[1])
    return [(span, candidate) for span, candidate, _ in order], [at for _, _, at in order]


def clarity(frames: Frames) -> float:
    """How sure SwiftF0 is of one pitch while a stem sounds, 0 to 1: its mean confidence
    over the louder frames. Chords leave it unsure. 1 for a stem with no frames. In a stem
    of pure tone, a frame that is a pure tone is one pitch for certain, whatever SwiftF0
    made of it, and so are the few frames either side: a pure note's start (an 808's click
    and glide) and its end. An 808 read as chords without.

    The louder frames are the loudest 60 percent of those within 20 dB of the stem's tenth
    loudest frame. Counted that way neither silence nor quiet bleed between phrases is among
    them: a line that sounds a quarter of the time reads as clearly as one that never stops
    (counted over all frames, such a line read as chords).
    """
    level = frames.level
    if not len(level):
        return 1.0
    nth = min(10, len(level))
    sounding = level >= np.partition(level, -nth)[-nth] - 20.0
    loud = sounding & (level >= np.percentile(level[sounding], 40))
    sure = frames.w
    if frames.pure is not None:
        beside = np.convolve(frames.pure, np.ones(2 * TONE_EDGE + 1), mode="same") > 0
        sure = np.where(beside, np.maximum(sure, TONE_CONFIDENCE), sure)
    return float(sure[loud].mean())


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
