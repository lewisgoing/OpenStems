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

    for seed in range(5, 13):
        rng = np.random.default_rng(seed)
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
        # SwiftF0 keeps a pitch on a frame it calls silent and gives it no confidence: in
        # the gaps, and here and there inside a note. Its segmenter counts those pitches
        # among the ones a note may take, and so must the port.
        silent = rng.random(n) < 0.3
        gaps = (pitch == 0) & silent
        pitch[gaps] = hz(rng.uniform(40, 80, int(gaps.sum())))
        conf[(rng.random(n) < 0.08) | gaps] = 0.0
        level = -30 + 10 * conf + rng.normal(0, 1.5, n)
        theirs = segment_notes(PitchResult(np.arange(n) * T.FRAME_S, pitch, conf, level))
        frames = T._to_frames(pitch, conf, level)
        mine = T._segment(frames, T._frame_cost(frames))
        assert len(mine) == len(theirs) > 10, seed
        for (a, b, mu), note in zip(mine, theirs, strict=True):
            assert a * T.FRAME_S == pytest.approx(note.start), seed
            assert b * T.FRAME_S == pytest.approx(note.end), seed
            assert hz(mu) == pytest.approx(note.pitch_hz, rel=1e-9), seed


def test_a_strike_ends_a_note_that_is_old_enough(monkeypatch: pytest.MonkeyPatch) -> None:
    n = 60
    frames = T._to_frames(np.full(n, hz(45.0)), np.full(n, 0.9), np.full(n, -20.0))
    cost = T._frame_cost(frames)

    def cuts(struck: np.ndarray | None) -> list[tuple[int, int]]:
        return [(a, b) for a, b, _ in T._segment(frames, cost, struck=struck)]

    assert cuts(None) == [(0, n)]  # one pitch throughout: one note
    again = np.zeros(n, dtype=bool)
    again[30] = True
    assert cuts(again) == [(0, 30), (30, n)]
    own = np.zeros(n, dtype=bool)
    own[2] = True  # the note's own strike, heard two frames late: it carries on
    assert cuts(own) == [(0, n)]
    # It is a rule, not a price: anything above a new note's cost cuts in the same place.
    for price in (T.NOTE_COST + 0.01, 1e9):
        monkeypatch.setattr(T, "ONSET_COST", price)
        assert cuts(again) == [(0, 30), (30, n)]


def test_candidates_lie_where_the_first_pass_found_nothing() -> None:
    default = [(10, 20, 60.0), (30, 40, 62.0)]
    relaxed = [(0, 6, 55.0), (10, 20, 60.0), (20, 30, 61.0), (28, 41, 62.0), (50, 51, 70.0)]
    # Kept: the two in the gaps. Dropped: the two that are the first pass's own, and one of
    # a single frame.
    assert T._outside(default, relaxed) == [(0, 6, 55.0), (20, 30, 61.0)]
    # A candidate that leans a little on a note is cut back to the gap.
    assert T._outside(default, [(18, 29, 61.0)]) == [(20, 29, 61.0)]
    assert T._outside([], [(3, 9, 50.0)]) == [(3, 9, 50.0)]
    # One that holds a short note of the first pass keeps its longest free stretch,
    # whichever side of that note it lies on.
    long = [(0, 100, 61.0)]
    assert T._outside([(1, 11, 60.0)], long) == [(11, 100, 61.0)]
    assert T._outside([(60, 70, 60.0)], long) == [(0, 60, 61.0)]
    assert T._outside([(10, 20, 60.0), (30, 40, 60.0)], long) == [(40, 100, 61.0)]
    # Up to three tenths of it may lie under the first pass's notes, no more.
    assert T._outside([(10, 40, 60.0)], long) == [(40, 100, 61.0)]
    assert T._outside([(10, 41, 60.0)], long) == []


def test_a_candidate_never_moves_a_note_of_the_first_pass() -> None:
    # A note struck at 1.0 s whose pitch settles three frames later. Alone, its start moves
    # back to the strike. The more willing pass calls the unsettled frames a note of their
    # own: that candidate must not hold the real note's start where the pitch settled.
    env = np.full(1000, -60.0)
    env[250:] = -20.0  # the level steps up at 1.0 s
    note = (64, 90, 40.0)  # pitch from 1.024 s
    _, alone = T._placed([note], [], env, snap=True)
    assert alone[0][0] == pytest.approx(1.0, abs=0.012) and alone[0][1] == 90 * T.FRAME_S
    spans, times = T._placed([note], [(61, 64, 43.0)], env, snap=True)
    assert spans == [((61, 64, 43.0), True), (note, False)]
    assert times[1] == alone[0]
    # The candidate takes what is left before the note, and nothing of it.
    assert times[0][0] == pytest.approx(61 * T.FRAME_S) and times[0][1] == times[1][0]
    # Without attacks to move to, every note keeps its frames' times.
    _, plain = T._placed([note], [(61, 64, 43.0)], env, snap=False)
    assert plain == [[61 * T.FRAME_S, 64 * T.FRAME_S], [64 * T.FRAME_S, 90 * T.FRAME_S]]


def slid_into(notes: Sequence[float], gain: float, hiss: float, every: float = 0.45) -> np.ndarray:
    """Plucked notes that each begin with 55 ms of a fainter tone a fourth up (a slide into
    the note, a neighbouring string), the note itself coming in as that ends. The first
    pass starts each note where its own pitch does; the more willing pass makes some of the
    faint tones notes of their own, right over the strike."""
    rng = np.random.default_rng(3)
    total = np.zeros(int((every * len(notes) + 0.6) * RATE))
    lead = int(0.055 * RATE)
    for i, note in enumerate(notes):
        lo = int((0.2 + i * every) * RATE)
        t = np.arange(lead) / RATE
        faint = sum(np.sin(2 * np.pi * hz(note + 5) * k * t) / k for k in range(1, 8))
        total[lo : lo + lead] += faint * np.minimum(1.0, t / 0.002) * gain
        total[lo : lo + lead] += rng.standard_normal(lead) * hiss
        t = np.arange(int((every - 0.085) * RATE)) / RATE
        wave = sum(np.sin(2 * np.pi * hz(note) * k * t) / k for k in range(1, 12))
        total[lo + lead : lo + lead + len(t)] += (
            wave * np.exp(-t * 9.0) * np.minimum(1.0, t / 0.004)
        )
    return (total * 0.25).astype(np.float32)


def test_the_first_passs_notes_are_the_same_with_and_without_candidates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The same audio read with the more willing pass and without it: the first pass's notes
    # must not differ by a sample. A candidate lying over a note's strike used to hold that
    # note's start where its pitch settled, 60 ms and more after the strike.
    real = T._outside
    found = 0
    for stem, line, gain, hiss in (
        ("bass", [40, 43, 45, 47, 43, 40, 45, 47], 0.25, 0.02),
        ("bass", [40, 43, 45, 47, 43, 40, 45, 47], 0.35, 0.05),
        ("guitar", [52, 55, 57, 59, 55, 52, 57, 59], 0.35, 0.05),
    ):
        audio = slid_into(line, gain, hiss)
        counted: list[int] = []

        def counting(
            default: Any, relaxed: Any, most: float = 0.3, counted: list[int] = counted
        ) -> Any:
            out = real(default, relaxed, most)
            counted.append(len(out))
            return out

        with monkeypatch.context() as patched:
            patched.setattr(T, "_outside", counting)
            both = transcribe_line(audio, RATE, stem)
        found += sum(counted)
        # In time order, none over the next, every curve inside its note.
        assert all(a.end <= b.start + 1e-6 for a, b in itertools.pairwise(both.notes))
        for n in both.notes:
            assert all(0 <= at <= n.duration for at, _ in n.bend)
        first = [
            (n.start, n.end, n.pitch)
            for n, x in zip(both.notes, both.features, strict=True)
            if not x[T.CANDIDATE]
        ]
        with monkeypatch.context() as patched:
            patched.setattr(T, "_outside", lambda default, relaxed, most=0.3: [])
            alone = transcribe_line(audio, RATE, stem)
        assert [(n.start, n.end, n.pitch) for n in alone.notes] == first, stem
    assert found > 0  # or nothing here was put to the test


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


def test_the_notes_do_not_depend_on_a_stems_gain() -> None:
    # SwiftF0 calls a frame under a fixed level silent, so a quiet stem used to lose notes.
    audio, _ = plucked([45, 47, 48, 50, 52])
    loud = transcribe_line(audio, RATE, "guitar").shown()
    assert keys(loud) == [45, 47, 48, 50, 52]
    for gain in (2.0, 0.1, 0.01, 0.002):
        quiet = transcribe_line(audio * np.float32(gain), RATE, "guitar").shown()
        assert keys(quiet) == keys(loud), gain
        assert [n.start for n in quiet] == pytest.approx([n.start for n in loud], abs=0.002)
        # within one: another build of the runtime may round a level the other way
        assert [n.velocity for n in quiet] == pytest.approx([n.velocity for n in loud], abs=1)


def test_a_bad_sample_is_silence_and_not_a_fault() -> None:
    # A decoder or a model can leave a sample that is no number, or float32's largest. SwiftF0
    # refuses such audio outright, and one frame without a confidence would poison the
    # segmenter's costs from there on.
    clean, _ = plucked([45, 47, 48, 50])
    wanted = keys(transcribe_line(clean, RATE, "bass").shown())
    assert wanted == [45, 47, 48, 50]
    for bad in (np.nan, np.inf, -np.inf, float(np.finfo(np.float32).max), 1e30):
        audio = clean.copy()
        audio[int(0.05 * RATE)] = bad  # in the silence before the first note
        assert keys(transcribe_line(np.stack([audio, audio]), RATE, "bass").shown()) == wanted
        assert np.isfinite(T.mono16(np.stack([audio, audio]), RATE)).all()
    assert np.abs(T.mono16(np.full((2, 100), np.finfo(np.float32).max), RATE)).max() == 0.0
    # Integer samples are sound, not defects: full scale is 1 whatever the width.
    pcm = np.array([0, 16384, -16384], dtype=np.int16)
    assert T.mono16(pcm, T.RATE).tolist() == [0.0, 0.5, -0.5]
    assert T.mono16(np.array([128, 255, 0], dtype=np.uint8), T.RATE).tolist() == [
        0.0,
        127 / 128,
        -1.0,
    ]
    assert T.mono16(np.zeros((2, 0), dtype=np.float32), RATE).size == 0
    # The same for what SwiftF0 answers: every weight and level is a number.
    odd = np.array([0.9, np.nan, np.inf, 0.8])
    frames = T._to_frames(np.full(4, 110.0), odd, np.array([-20.0, np.nan, -np.inf, np.inf]))
    assert frames.w.tolist() == [0.9, 0.0, 0.0, 0.8]
    assert np.isfinite(frames.level).all() and frames.valid.all()
    assert np.isfinite(T._frame_cost(frames)).all()


def test_a_click_does_not_set_the_level_a_stem_is_read_at() -> None:
    audio, _ = plucked([45, 47, 48, 50])
    level = T.peak_level(T.mono16(audio, RATE))
    clicked = audio.copy()
    clicked[int(0.05 * RATE)] = 3.0  # one sample, far over everything else
    assert T.peak_level(T.mono16(clicked, RATE)) == pytest.approx(level, rel=0.05)
    assert keys(transcribe_line(clicked, RATE, "bass").shown()) == [45, 47, 48, 50]
    assert T.peak_level(np.zeros(0, dtype=np.float32)) == 0.0
    assert T.peak_level(np.array([0.5, -0.25], dtype=np.float32)) == 0.25  # fewer than 32


def test_a_line_that_seldom_sounds_is_still_a_line() -> None:
    # Four notes, then four times as long with only hiss 70 dB down, as a separated stem
    # has between phrases. Counted over all its louder frames such a stem read as chords.
    melody = sung([60, 64, 67, 72])
    hiss = np.random.default_rng(6).standard_normal(4 * len(melody)) * 1e-4
    dense = transcribe_line(melody, RATE, "vocals")
    sparse = transcribe_line(np.concatenate([melody, hiss.astype(np.float32)]), RATE, "vocals")
    assert dense.texture == sparse.texture == "line"
    assert sparse.clarity == pytest.approx(dense.clarity, abs=0.03)
    assert keys(sparse.shown()) == [60, 64, 67, 72]
    # Chords with as much hiss after them are chords all the same.
    triads = np.concatenate(
        [sum(sung([root + k], seconds=1.0, gap=0.05) for k in (0, 4, 7, 12)) for root in (48, 53)]
    ).astype(np.float32)
    tail = (np.random.default_rng(7).standard_normal(4 * len(triads)) * 1e-4).astype(np.float32)
    assert transcribe_line(np.concatenate([triads, tail]), RATE, "guitar").texture == "chords"
    assert T.clarity(T.Frames(np.zeros(0), np.zeros(0), np.zeros(0))) == 1.0


def test_any_sample_rate_is_read_alike() -> None:
    import soxr

    wanted = [57, 60, 64, 69]
    audio = sung(wanted)
    for rate in (48000, 22050, 16000, 8000):
        other = soxr.resample(audio, RATE, rate).astype(np.float32)
        shown = transcribe_line(other, rate, "vocals").shown()
        assert keys(shown) == wanted, rate
        assert [n.start for n in shown] == pytest.approx([0.0, 0.58, 1.16, 1.74], abs=0.04)


def test_a_curve_lies_inside_a_note_whose_start_moved() -> None:
    # A plucked note with vibrato on the bass profile: its start moves back to the strike,
    # before the first frame with a pitch, and its curve is counted from that start.
    seconds, at = 1.2, 0.2
    t = np.arange(int(seconds * RATE)) / RATE
    cents = 50 * np.sin(2 * np.pi * 5.0 * t)
    phase = 2 * np.pi * np.cumsum(hz(40) * 2 ** (cents / 1200)) / RATE
    ring = np.exp(-t * 1.5) * np.minimum(1.0, t / 0.003)
    wave = sum(np.sin(k * phase) / k for k in range(1, 12)) * ring
    audio = np.zeros(int((at + seconds + 0.3) * RATE))
    audio[int(at * RATE) : int(at * RATE) + len(wave)] = wave
    (note,) = transcribe_line((audio * 0.25).astype(np.float32), RATE, "bass").shown()
    assert round(note.pitch) == 40 and abs(note.start - at) < 0.02
    assert len(note.bend) > 8
    times = [point[0] for point in note.bend]
    assert times == sorted(set(times)) and times[0] >= 0 and times[-1] <= note.duration
    assert max(v for _, v in note.bend) > 0.25 and min(v for _, v in note.bend) < -0.25


def test_a_short_sound_is_read_on_every_profile() -> None:
    # Just over the quarter second that is read at all: the bass's second pass at double
    # speed has half as many frames to work with.
    short = sung([45], seconds=0.3, gap=0.0)
    for stem in ("vocals", "bass", "guitar"):
        found = transcribe_line(short, RATE, stem)
        assert [round(n.pitch) for n in found.shown()] in ([45], []), stem
    assert transcribe_line(short[: int(0.2 * RATE)], RATE, "bass").notes == ()  # too short
