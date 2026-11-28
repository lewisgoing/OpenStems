"""Stem to MIDI for stems that play chords (Phase 7, stage M4): `audio/chords.py`.

The note maker is tested on posteriors written by hand. The model itself is not in the
repository: the last test runs it when `OPENSTEMS_BASIC_PITCH` names its file.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

from openstems.audio import chords as C

RATE = 44100


def blank(frames: int = 200) -> tuple[np.ndarray, np.ndarray]:
    return np.zeros((frames, C.KEYS), np.float32), np.zeros((frames, C.KEYS), np.float32)


def sound(
    note: np.ndarray, onset: np.ndarray, key: int, first: int, after: int, struck: bool = True
) -> None:
    note[first:after, key - C.LOWEST_KEY] = 0.9
    if struck:
        onset[first, key - C.LOWEST_KEY] = 0.9


def keys(notes: tuple[C.Note, ...]) -> list[int]:
    return [round(n.pitch) for n in notes]


def test_a_chord_is_every_one_of_its_notes() -> None:
    note, onset = blank()
    for key in (60, 64, 67):
        sound(note, onset, key, 20, 100)
    found = C.notes_from(note, onset)
    assert keys(found) == [60, 64, 67]
    for n in found:
        assert n.start == pytest.approx(20 * C.HOP / C.RATE, abs=0.001)
        assert n.end == pytest.approx(100 * C.HOP / C.RATE, abs=0.02)
        assert n.confidence == pytest.approx(0.9, abs=0.01)
        assert n.velocity == 114


def test_a_key_struck_again_is_two_notes() -> None:
    note, onset = blank()
    sound(note, onset, 60, 20, 60)
    sound(note, onset, 60, 60, 120)
    found = C.notes_from(note, onset)
    assert keys(found) == [60, 60]
    assert found[0].end <= found[1].start + 1e-6


def test_a_short_blip_is_not_a_note() -> None:
    note, onset = blank()
    sound(note, onset, 60, 20, 20 + C.LEAST)
    assert C.notes_from(note, onset) == ()


def test_a_note_with_no_onset_is_still_found() -> None:
    note, onset = blank()
    sound(note, onset, 55, 0, 80, struck=False)  # sounding from the stem's first frame
    onset[100, 3] = 0.9  # some onset elsewhere, so the rises are not all there is
    assert keys(C.notes_from(note, onset)) == [55]


def test_a_dip_shorter_than_the_grace_does_not_end_a_note() -> None:
    note, onset = blank()
    sound(note, onset, 48, 20, 120)
    note[20:120, 48 - C.LOWEST_KEY] = 0.7
    # Under FRAME_AT for less than the grace, and back up by too little to be a new start.
    note[60 : 60 + C.GRACE - 2, 48 - C.LOWEST_KEY] = 0.25
    assert keys(C.notes_from(note, onset)) == [48]


def test_the_neighbouring_keys_of_a_note_are_its_own_spill() -> None:
    note, onset = blank()
    sound(note, onset, 60, 20, 100)
    note[20:100, 61 - C.LOWEST_KEY] = 0.4  # over FRAME_AT, never struck
    assert keys(C.notes_from(note, onset)) == [60]


def test_nothing_is_no_notes() -> None:
    assert C.notes_from(*blank()) == ()
    assert C.notes_from(*blank(2)) == ()
    assert C.transcribe_chords(np.zeros(10, np.float32), RATE, Path("unused.onnx")) == ()


def test_frame_times_step_back_a_little_at_each_window() -> None:
    times = C.frame_times(400)
    assert times[0] == 0.0
    assert times[1] == pytest.approx(C.HOP / C.RATE)
    assert times[172] - times[171] < C.HOP / C.RATE
    assert np.all(np.diff(times) > 0)


def test_the_model_hears_a_triad() -> None:
    path = os.environ.get("OPENSTEMS_BASIC_PITCH")
    if not path or not Path(path).is_file():
        pytest.skip("OPENSTEMS_BASIC_PITCH does not name Basic Pitch's model file")
    t = np.arange(int(1.5 * RATE)) / RATE
    chord = np.zeros_like(t)
    for key in (60, 64, 67):
        f = 440.0 * 2 ** ((key - 69) / 12)
        chord += sum(np.sin(2 * np.pi * f * k * t) / k for k in range(1, 6))
    chord *= np.minimum(1.0, t / 0.005) * np.exp(-2.0 * t)
    audio = np.concatenate([np.zeros(RATE // 2), chord, np.zeros(RATE // 2)])
    audio = (audio / np.abs(audio).max() * 0.4).astype(np.float32)
    found = C.transcribe_chords(audio, RATE, Path(path))
    # A made tone's overtones are heard as notes too (the model learned real instruments):
    # the chord's own three keys are there, and they are the surest.
    surest = sorted(found, key=lambda n: -(n.confidence or 0.0))[:3]
    assert sorted(keys(tuple(surest))) == [60, 64, 67]
    assert all(abs(n.start - 0.5) < 0.05 for n in surest)
