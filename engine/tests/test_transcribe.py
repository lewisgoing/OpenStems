"""Stem to MIDI for single-line stems (Phase 7, stage M3): `audio/transcribe.py`.

Synthetic audio with known notes. How good the transcriber is on real recordings is the
benchmark's question (`scripts/midi_bench.py`), not these tests'.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Sequence
from typing import Any

import numpy as np
import pytest

from openstems.audio import transcribe as T
from openstems.audio.transcribe import transcribe_line
from openstems.domain.notes import MIDI_STEMS, line_kind

RATE = 44100


def hz(note: Any) -> Any:
    return 440.0 * 2 ** ((note - 69) / 12)


def sung(notes: Sequence[float], seconds: float = 0.5, gap: float = 0.08) -> np.ndarray:
    """Steady harmonic tones with soft edges and a silence between them."""
    parts = []
    for note in notes:
        t = np.arange(int(seconds * RATE)) / RATE
        edge = np.minimum(1.0, np.minimum(t, seconds - t) / 0.02)
        wave = sum(np.sin(2 * np.pi * hz(note) * k * t) / k for k in range(1, 6))
        parts += [wave * edge, np.zeros(int(gap * RATE))]
    return (np.concatenate(parts) * 0.3).astype(np.float32)


def plucked(notes: Sequence[float], every: float = 0.4) -> tuple[np.ndarray, list[float]]:
    """Notes struck one after another with no silence between: each still rings, fading,
    when the next is struck and stops it, as a string does, with the short noise of the
    strike itself. Returns the audio and the moment each was struck."""
    total = np.zeros(int((every * len(notes) + 0.5) * RATE))
    starts = []
    click = np.random.default_rng(4).standard_normal(int(0.004 * RATE)) * np.hanning(
        int(0.004 * RATE)
    )
    for i, note in enumerate(notes):
        at = 0.2 + i * every
        starts.append(at)
        t = np.arange(int(every * RATE)) / RATE
        wave = sum(np.sin(2 * np.pi * hz(note) * k * t) / k for k in range(1, 12))
        wave *= np.exp(-t * 3.0) * np.minimum(1.0, t / 0.003) * np.minimum(1.0, (every - t) / 0.004)
        wave[: len(click)] += 0.6 * click  # the pick or the finger: a few ms of noise
        lo = int(at * RATE)
        total[lo : lo + len(wave)] += wave
    return (total * 0.25).astype(np.float32), starts


def keys(notes) -> list[int]:
    return [round(n.pitch) for n in notes]


def test_a_sung_melody_becomes_its_notes() -> None:
    wanted = [60, 64, 67, 72, 67]
    found = transcribe_line(sung(wanted), RATE, "vocals")
    shown = found.shown()
    assert found.profile == "voice"
    assert keys(shown) == wanted
    assert all(0.35 < n.duration < 0.6 for n in shown)
    assert all(abs(n.start - (i * 0.58)) < 0.04 for i, n in enumerate(shown))
    # In time order, none over the next, each with a confidence and a velocity.
    assert all(a.end <= b.start + 1e-6 for a, b in itertools.pairwise(shown))
    assert all(n.confidence is not None and 0 <= n.confidence <= 1 for n in found.notes)
    assert all(1 <= n.velocity <= 127 for n in found.notes)


def test_stereo_and_mono_are_read_alike() -> None:
    mono = sung([57, 60, 64])
    a = transcribe_line(mono, RATE, "vocals").shown()
    b = transcribe_line(np.stack([mono, mono]), RATE, "vocals").shown()
    assert keys(a) == keys(b) == [57, 60, 64]


def test_a_bass_is_heard_under_swiftf0s_floor() -> None:
    # E1 is 41.2 Hz and B0 30.9 Hz; SwiftF0 reports nothing under 46.9 Hz. A bass is read a
    # second time at double speed, where both are inside its range.
    wanted = [28, 23, 31, 36]  # E1, B0, G1, C2
    audio = sung(wanted, seconds=0.6)
    assert keys(transcribe_line(audio, RATE, "bass").shown()) == wanted
    # Any other stem is read once: the two notes under the floor are not there.
    assert keys(transcribe_line(audio, RATE, "guitar").shown()) == [31, 36]


def test_a_note_struck_again_is_two_notes() -> None:
    # The same pitch four times, each struck while the last still rings: nothing in the
    # pitch says where one ends. A plucked line is cut at the onsets.
    audio, starts = plucked([45, 45, 45, 45])
    for stem in ("bass", "guitar"):
        shown = transcribe_line(audio, RATE, stem).shown()
        assert keys(shown) == [45, 45, 45, 45], stem
        assert all(abs(n.start - at) < 0.03 for n, at in zip(shown, starts, strict=True)), stem


def test_a_bass_notes_start_is_where_it_was_struck() -> None:
    audio, starts = plucked([33, 36, 38, 40, 43], every=0.5)
    shown = transcribe_line(audio, RATE, "bass").shown()
    assert keys(shown) == [33, 36, 38, 40, 43]
    late = [n.start - at for n, at in zip(shown, starts, strict=True)]
    assert max(abs(x) for x in late) < 0.02  # the pitch alone settles some 25 ms later


def test_silence_and_scraps_hold_no_notes() -> None:
    assert transcribe_line(np.zeros(RATE * 2, dtype=np.float32), RATE, "vocals").notes == ()
    assert transcribe_line(np.zeros(100, dtype=np.float32), RATE, "bass").notes == ()
    hiss = (np.random.default_rng(1).standard_normal(RATE * 2) * 1e-5).astype(np.float32)
    assert transcribe_line(hiss, RATE, "vocals").notes == ()
    noise = (np.random.default_rng(2).standard_normal(RATE * 2) * 0.2).astype(np.float32)
    assert transcribe_line(noise, RATE, "vocals").shown() == []


def test_vibrato_is_a_curve_and_a_steady_note_has_none() -> None:
    t = np.arange(int(1.5 * RATE)) / RATE
    cents = 60 * np.sin(2 * np.pi * 5.5 * t)  # 60 cents each way, 5.5 times a second
    phase = 2 * np.pi * np.cumsum(hz(64) * 2 ** (cents / 1200)) / RATE
    edge = np.minimum(1.0, np.minimum(t, 1.5 - t) / 0.03)
    wobble = (sum(np.sin(k * phase) / k for k in range(1, 6)) * edge * 0.3).astype(np.float32)
    (note,) = transcribe_line(wobble, RATE, "vocals").shown()
    assert round(note.pitch) == 64 and len(note.bend) > 10
    swing = [value for _, value in note.bend]
    assert 0.35 < max(swing) < 0.8 and -0.8 < min(swing) < -0.35
    assert all(0 <= at <= note.duration for at, _ in note.bend)
    (steady,) = transcribe_line(sung([64], seconds=1.5), RATE, "vocals").shown()
    assert steady.bend == ()


def test_tuning_is_read_from_the_notes() -> None:
    sharp = transcribe_line(sung([60.3, 64.3, 67.3, 72.3]), RATE, "bass")
    assert sharp.tuning_cents == pytest.approx(30, abs=4) and sharp.tuning_strength > 0.9
    assert T.tuning_strength([60.0, 62.5], [1.0, 1.0]) == pytest.approx(0.0, abs=1e-9)
    assert T.tuning_strength([60.2, 64.2, 67.2], [1.0, 2.0, 3.0]) == pytest.approx(1.0)
    assert T.tuning_strength([], []) == 0.0


def test_candidates_stay_under_the_line() -> None:
    # A loud line with a very quiet note in a gap: found, kept, and not shown.
    loud = sung([60, 64, 67], gap=0.5)
    quiet = sung([62], seconds=0.25)[: int(0.25 * RATE)] * 0.01
    at = int(0.62 * RATE)
    loud[at : at + len(quiet)] += quiet
    found = transcribe_line(loud, RATE, "guitar")
    assert keys(found.shown()) == [60, 64, 67]
    under = [n for n in found.notes if (n.confidence or 0) < found.threshold]
    assert all(n not in found.shown() for n in under)
    assert len(found.features) == len(found.notes)
    assert all(len(x) == len(T.FEATURES) for x in found.features)


def test_the_segmenter_is_swiftf0s_own_without_onsets() -> None:
    # `_segment` is a port of swift_f0.segment_notes: with no onsets it must cut the same
    # frames into the same notes, or the benchmark's figures no longer describe it.
    from swift_f0 import PitchResult, segment_notes

    rng = np.random.default_rng(5)
    n = 900
    pitch = np.zeros(n)
    conf = np.zeros(n)
    at = 0
    while at < n - 40:
        length = int(rng.integers(8, 60))
        note = rng.uniform(40, 80)
        pitch[at : at + length] = hz(note + rng.normal(0, 0.15, min(length, n - at)))
        conf[at : at + length] = rng.uniform(0.55, 0.99, min(length, n - at))
        at += length + int(rng.integers(0, 12))
    level = -30 + 10 * conf + rng.normal(0, 1.5, n)
    theirs = segment_notes(PitchResult(np.arange(n) * T.FRAME_S, pitch, conf, level))
    frames = T._to_frames(pitch, conf, level)
    mine = T._segment(frames, T._frame_cost(frames))
    assert len(mine) == len(theirs) > 10
    for (a, b, mu), note in zip(mine, theirs, strict=True):
        assert a * T.FRAME_S == pytest.approx(note.start) and b * T.FRAME_S == pytest.approx(
            note.end
        )
        assert hz(mu) == pytest.approx(note.pitch_hz, rel=1e-9)


def test_candidates_lie_where_the_first_pass_found_nothing() -> None:
    default = [(10, 20, 60.0), (30, 40, 62.0)]
    relaxed = [(0, 6, 55.0), (10, 20, 60.0), (20, 30, 61.0), (28, 41, 62.0), (50, 51, 70.0)]
    # Kept: the two in the gaps. Dropped: the two that are the first pass's own, and one of
    # a single frame.
    assert T._outside(default, relaxed) == [(0, 6, 55.0), (20, 30, 61.0)]
    # A candidate that leans a little on a note is cut back to the gap.
    assert T._outside(default, [(18, 29, 61.0)]) == [(20, 29, 61.0)]
    assert T._outside([], [(3, 9, 50.0)]) == [(3, 9, 50.0)]


def test_onset_peaks_and_attacks() -> None:
    strength = np.zeros(100)
    strength[[20, 22, 60]] = [5.0, 4.0, 3.0]
    assert np.flatnonzero(T.onset_peaks(strength, 2.0)).tolist() == [20, 60]  # 22 is too near
    assert np.flatnonzero(T.onset_peaks(strength, 4.0)).tolist() == [20]
    env = np.full(200, -60.0)
    env[100:] = -20.0  # a step up at 0.4 s
    found = T.attack(env, 0.43)
    assert found is not None and abs(found[0] - 0.4) < 0.012 and found[1] > 20
    assert T.attack(np.full(200, -30.0), 0.4) is None  # nothing rises


def test_chords_are_told_from_a_line() -> None:
    # Four notes at once leave SwiftF0 unsure of any one pitch: the stem is marked as chords
    # and what is found is one line of them. A melody, sung or plucked, is a line.
    triads = np.concatenate(
        [
            sum(sung([root + k], seconds=1.0, gap=0.05) for k in (0, 4, 7, 12))
            for root in (48, 53, 55)
        ]
    )
    found = transcribe_line(triads, RATE, "guitar")
    assert found.texture == "chords" and found.clarity < T.LINE_CLARITY
    assert transcribe_line(sung([60, 64, 67]), RATE, "guitar").texture == "line"
    assert transcribe_line(plucked([45, 47, 48])[0], RATE, "bass").texture == "line"
    assert T.Transcription().texture == "line"  # nothing found is not called chords


def test_which_stems_are_read_how() -> None:
    assert [line_kind(s) for s in ("vocals", "Lead Vocals", "dry vocals")] == ["voice"] * 3
    assert [line_kind(s) for s in ("bass", "double-bass")] == ["bass", "bass"]
    assert [line_kind(s) for s in ("guitar", "piano", "other", "melody", "violin")] == ["line"] * 5
    assert [line_kind(s) for s in ("drums", "kick", "hh", "instrumental", "drumless")] == [None] * 5
    # What the write_midi setting reads by itself: single lines by nature.
    assert {"vocals", "bass", "lead vocals", "melody"} <= set(MIDI_STEMS)
    assert not {"drums", "guitar", "piano", "other"} & set(MIDI_STEMS)
    assert set(T.PROFILES) == {"voice", "bass", "line"}
    for profile in T.PROFILES.values():
        assert len(profile.weights) == len(T.FEATURES) + 1 and 0 < profile.threshold < 1
    assert math.isclose(T.FRAME_S, 0.016)
