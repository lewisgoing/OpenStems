"""Phase 7, M1: note objects, the notes file, and the format 1 MIDI writer."""

from __future__ import annotations

import json
from typing import Any

import pytest

from openstems.audio.midi import (
    DRUM_CHANNEL,
    MPE_MEMBER_RANGE,
    MPE_MEMBERS,
    TICKS_PER_BEAT,
    Part,
    key_signature,
    midi_bytes,
    midi_file_bytes,
    read_midi_notes,
    read_tracks,
)
from openstems.domain.errors import DomainError
from openstems.domain.notes import (
    Note,
    estimate_tuning,
    from_sidecar,
    round_pitch,
    to_sidecar,
    velocity_from_db,
)


def _channel_events(track, kinds=(0x80, 0x90, 0xB0, 0xC0, 0xD0, 0xE0)):
    return [(t, m) for t, m in track if m[0] & 0xF0 in kinds]


def _notes_of(track) -> list[tuple[int, int, int, int, int]]:
    """(channel, key, velocity, on tick, off tick) for each note in a track."""
    open_: dict[tuple[int, int], tuple[int, int]] = {}
    out = []
    for tick, m in track:
        kind, channel = m[0] & 0xF0, m[0] & 0x0F
        if kind == 0x90 and m[2] > 0:
            open_[(channel, m[1])] = (tick, m[2])
        elif kind in (0x80, 0x90):
            on, velocity = open_.pop((channel, m[1]))
            out.append((channel, m[1], velocity, on, tick))
    return sorted(out, key=lambda n: (n[3], n[1]))


def _bend_semitones(message: bytes, bend_range: int) -> float:
    return ((message[1] | message[2] << 7) - 8192) / 8192 * bend_range


def _rpn_values(track, channel: int) -> dict[int, int]:
    """The registered parameters set on a channel, in order, read from CC 101/100/6."""
    values: dict[int, int] = {}
    msb = lsb = 127
    for _, m in track:
        if m[0] != 0xB0 | channel:
            continue
        if m[1] == 101:
            msb = m[2]
        elif m[1] == 100:
            lsb = m[2]
        elif m[1] == 6 and (msb, lsb) != (127, 127):
            values[msb << 7 | lsb] = m[2]
    return values


# -- note objects -------------------------------------------------------------------------


def test_a_note_checks_itself() -> None:
    Note(0.0, 0.5, 60.0)
    cases: list[dict[str, Any]] = [
        dict(start=1.0, end=1.0, pitch=60.0),
        dict(start=-0.1, end=1.0, pitch=60.0),
        dict(start=0.0, end=1.0, pitch=128.5),
        dict(start=0.0, end=1.0, pitch=60.0, velocity=0),
        dict(start=0.0, end=1.0, pitch=60.0, confidence=1.5),
        dict(start=0.0, end=1.0, pitch=60.0, bend=((0.5, 1.0), (0.2, 0.0))),
        dict(start=0.0, end=1.0, pitch=60.0, bend=((1.5, 1.0),)),
    ]
    for bad in cases:
        with pytest.raises(DomainError):
            Note(**bad)


def test_bend_at_holds_the_last_point() -> None:
    note = Note(1.0, 2.0, 60.0, bend=((0.0, 0.0), (0.25, 0.5), (0.5, -0.25)))
    assert note.bend_at(0.1) == 0.0
    assert note.bend_at(0.25) == 0.5
    assert note.bend_at(0.9) == -0.25
    assert Note(0.0, 1.0, 60.0).bend_at(0.5) == 0.0


def test_tuning_is_the_circular_mean_of_the_fractions() -> None:
    assert estimate_tuning([]) == 0.0
    assert estimate_tuning([60.2, 64.2, 67.2]) == pytest.approx(20.0)
    # Around the wrap: -45 and +45 cents average to -50/+50, not to 0.
    assert abs(estimate_tuning([59.55, 60.45])) == pytest.approx(50.0)
    # Weights pull toward the long notes.
    assert estimate_tuning([60.1, 62.3], weights=[3.0, 1.0]) == pytest.approx(15.0, abs=1.5)


def test_rounding_follows_the_tuning() -> None:
    assert round_pitch(60.6) == (61, pytest.approx(-0.4))
    key, rest = round_pitch(60.6, tuning_cents=30)
    assert key == 60 and rest == pytest.approx(0.6)
    assert round_pitch(59.6, tuning_cents=-45)[0] == 60
    assert round_pitch(130.0)[0] == 127 and round_pitch(-3.0)[0] == 0


def test_velocity_is_linear_in_decibels() -> None:
    assert velocity_from_db(0.0) == 127
    assert velocity_from_db(-50.0) == 1
    assert velocity_from_db(-25.0) == 64
    assert velocity_from_db(6.0) == 127 and velocity_from_db(-90.0) == 1
    assert velocity_from_db(float("-inf")) == 1


# -- the notes file -----------------------------------------------------------------------


def test_the_notes_file_round_trips_through_json() -> None:
    notes = [
        Note(0.5, 1.0, 64.3, 90, confidence=0.8, bend=((0.0, 0.0), (0.2, 0.5))),
        Note(0.0, 0.4, 60.0, 100),
    ]
    data = json.loads(json.dumps(to_sidecar(notes, stem="vocals", tuning_cents=12.5)))
    assert data["format"] == "openstems.notes" and data["version"] == 1
    assert [n["start"] for n in data["notes"]] == [0.0, 0.5]  # in time order
    back, meta = from_sidecar(data)
    assert back == sorted(notes, key=lambda n: n.start)
    assert meta["stem"] == "vocals" and meta["tuning_cents"] == 12.5


def test_drum_notes_keep_their_part() -> None:
    data = to_sidecar([Note(0.0, 0.05, 36, 110, drum="kick")], stem="drums", kind="drums")
    back, meta = from_sidecar(data)
    assert back[0].drum == "kick" and meta["kind"] == "drums"


def test_the_notes_file_refuses_what_it_does_not_know() -> None:
    good = to_sidecar([Note(0.0, 1.0, 60.0)], stem="bass")
    for bad in (
        [],
        {**good, "format": "other"},
        {**good, "version": 2},
        {**good, "kind": "chords"},
        {**good, "notes": [{"start": 0.0}]},
        {**good, "notes": [{"start": 1.0, "end": 0.5, "pitch": 60}]},
    ):
        with pytest.raises(DomainError):
            from_sidecar(bad)
    with pytest.raises(DomainError):
        to_sidecar([], stem="x", kind="chords")


# -- the format 1 writer ------------------------------------------------------------------


def test_plain_parts_round_trip() -> None:
    bass = Part("bass", [Note(0.0, 0.5, 40.2, 90), Note(0.5, 1.0, 43.0, 70)], program=33)
    keys = Part("keys", [Note(0.0, 1.0, 60.0), Note(0.0, 1.0, 64.0)], program=4)
    drums = Part("drums", [Note(0.0, 0.05, 36, 120, drum="kick")], drums=True)
    data = midi_file_bytes([bass, keys, drums], bpm=120.0, key="Em")
    fmt, division, tracks = read_tracks(data)
    assert (fmt, division, len(tracks)) == (1, TICKS_PER_BEAT, 4)
    conductor = [m for _, m in tracks[0]]
    assert b"\xff\x51\x07\xa1\x20" in conductor  # 500000 us per beat: 120 BPM
    assert b"\xff\x59\x01\x01" in conductor  # E minor: one sharp, minor
    assert tracks[1][0] == (0, b"\xff\x03bass")
    assert (0, bytes([0xC0, 33])) in tracks[1]
    assert _notes_of(tracks[1]) == [(0, 40, 90, 0, 480), (0, 43, 70, 480, 960)]
    assert {n[0] for n in _notes_of(tracks[2])} == {1}  # the next channel
    assert _notes_of(tracks[3]) == [(DRUM_CHANNEL, 36, 120, 0, 48)]
    assert not any(m[0] & 0xF0 == 0xC0 for _, m in tracks[3])  # no program on drums
    assert not any(m[0] & 0xF0 == 0xE0 for t in tracks for _, m in t)  # plain: no bends


def test_pitched_parts_skip_the_drum_channel() -> None:
    parts = [Part(f"p{i}", [Note(0.0, 1.0, 60.0)]) for i in range(10)]
    _, _, tracks = read_tracks(midi_file_bytes(parts))
    channels = [_notes_of(t)[0][0] for t in tracks[1:]]
    assert channels == [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]


def test_plain_notes_go_to_the_key_of_the_tuning() -> None:
    part = Part("v", [Note(0.0, 1.0, 60.6)])
    _, _, tracks = read_tracks(midi_file_bytes([part]))
    assert _notes_of(tracks[1])[0][1] == 61
    _, _, tracks = read_tracks(midi_file_bytes([part], tuning_cents=30))
    assert _notes_of(tracks[1])[0][1] == 60


def test_bends_declare_their_range_first_and_lead_each_note() -> None:
    curve = ((0.0, 0.0), (0.1, 0.5), (0.2, 1.0), (0.3, 1.0))
    part = Part("lead", [Note(0.0, 0.5, 60.25, bend=curve), Note(0.5, 1.0, 62.0)])
    _, _, tracks = read_tracks(midi_file_bytes([part], pitch="bend", bend_range=12))
    track = tracks[1]
    assert _rpn_values(track, 0) == {0: 12}
    events = _channel_events(track)
    first_note = next(i for i, (_, m) in enumerate(events) if m[0] == 0x90)
    rpn_done = max(i for i, (_, m) in enumerate(events) if m[0] == 0xB0)
    assert rpn_done < first_note  # the range is set before any note
    # Each Note On is preceded, on its tick, by the bend that note starts at.
    for i, (tick, m) in enumerate(events):
        if m[0] == 0x90:
            before = [b for t, b in events[:i] if t == tick and b[0] == 0xE0]
            assert before, f"no bend before the note at tick {tick}"
    bends = [(t, _bend_semitones(m, 12)) for t, m in events if m[0] == 0xE0]
    assert bends[0] == (0, pytest.approx(0.25, abs=0.002))
    assert [round(b, 2) for _, b in bends[1:3]] == [0.75, 1.25]  # offset plus the curve
    assert len([b for b in bends if b[0] < 480]) == 3  # the repeated value is not resent
    assert bends[-1] == (480, pytest.approx(0.0, abs=0.002))  # the next note resets it


def test_bends_beyond_the_range_are_clamped() -> None:
    part = Part("lead", [Note(0.0, 0.5, 60.0, bend=((0.0, 0.0), (0.1, 5.0)))])
    _, _, tracks = read_tracks(midi_file_bytes([part], pitch="bend", bend_range=2))
    values = [m[1] | m[2] << 7 for _, m in tracks[1] if m[0] == 0xE0]
    assert max(values) == 16383


def test_mpe_zone_and_member_setup() -> None:
    part = Part("keys", [Note(0.0, 1.0, 60.0), Note(0.0, 1.0, 64.1), Note(1.0, 2.0, 67.0)])
    _, _, tracks = read_tracks(midi_file_bytes([part], pitch="mpe"))
    track = tracks[1]
    assert _rpn_values(track, 0) == {6: 15, 0: 2}  # the configuration message, master +/-2
    for channel in MPE_MEMBERS:
        assert _rpn_values(track, channel) == {0: MPE_MEMBER_RANGE}
    notes = _notes_of(track)
    assert all(n[0] in MPE_MEMBERS for n in notes)
    assert notes[0][0] != notes[1][0]  # simultaneous notes on their own channels
    # Bend, CC74 and pressure are on the note's channel before its Note On.
    events = _channel_events(track)
    for i, (tick, m) in enumerate(events):
        if m[0] & 0xF0 == 0x90:
            channel = m[0] & 0x0F
            before = {b[0] & 0xF0 for t, b in events[:i] if t == tick and b[0] & 0x0F == channel}
            assert {0xE0, 0xB0, 0xD0} <= before
    second = next(m for _, m in events if m[0] == 0xE0 | notes[1][0])
    assert _bend_semitones(second, MPE_MEMBER_RANGE) == pytest.approx(0.1, abs=0.01)


def test_mpe_reuses_the_channel_released_longest_ago() -> None:
    notes = [Note(i * 0.5, i * 0.5 + 0.4, 60.0 + i) for i in range(20)]
    _, _, tracks = read_tracks(midi_file_bytes([Part("p", notes)], pitch="mpe"))
    channels = [n[0] for n in _notes_of(tracks[1])]
    assert channels[:15] == list(MPE_MEMBERS) and channels[15:] == [1, 2, 3, 4, 5]


def test_mpe_overflow_falls_back_to_plain_notes_on_the_master() -> None:
    notes = [Note(0.0, 1.0, 40.0 + i) for i in range(17)]
    _, _, tracks = read_tracks(midi_file_bytes([Part("p", notes)], pitch="mpe"))
    channels = sorted(n[0] for n in _notes_of(tracks[1]))
    assert channels == [0, 0, *MPE_MEMBERS]
    assert not any(m[0] == 0xE0 for _, m in tracks[1])  # no bend on the master


def test_the_writer_refuses_bad_requests() -> None:
    one = Part("p", [Note(0.0, 1.0, 60.0)])
    drums = Part("d", [Note(0.0, 0.1, 36)], drums=True)
    with pytest.raises(ValueError):
        midi_file_bytes([one], pitch="chords")
    with pytest.raises(ValueError):
        midi_file_bytes([one, one], pitch="mpe")
    with pytest.raises(ValueError):
        midi_file_bytes([one, drums], pitch="mpe")
    with pytest.raises(ValueError):
        midi_file_bytes([one], pitch="bend", bend_range=0)


def test_key_signatures() -> None:
    assert key_signature(None) is None and key_signature("H") is None
    assert key_signature("C") == b"\x00\x00"
    assert key_signature("Am") == b"\x00\x01"
    assert key_signature("F#") == b"\x06\x00"
    assert key_signature("C#") == bytes([(-5) & 0xFF, 0])  # written as Db
    assert key_signature("Dm") == bytes([(-1) & 0xFF, 1])
    assert key_signature("G#m") == b"\x05\x01"


def test_read_tracks_reads_running_status_and_format_0() -> None:
    data = midi_bytes([(0.0, 0.5, 60, 100)])
    fmt, _, tracks = read_tracks(data)
    assert fmt == 0 and _notes_of(tracks[0]) == [(0, 60, 100, 0, 480)]
    assert read_midi_notes(data)[0] == [(0.0, 0.5, 60, 100)]  # format 0 is unchanged
    # Running status: two Note Ons with one status byte.
    body = b"\x00\x90\x3c\x40\x00\x40\x40\x60\x80\x3c\x00\x00\x80\x40\x00\x00\xff\x2f\x00"
    raw = b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x01\xe0MTrk" + len(body).to_bytes(4, "big") + body
    _, _, tracks = read_tracks(raw)
    assert [n[1] for n in _notes_of(tracks[0])] == [60, 64]


def test_times_land_on_the_tempo_grid() -> None:
    part = Part("p", [Note(1.0, 1.5, 60.0)])
    _, _, tracks = read_tracks(midi_file_bytes([part], bpm=90.0))
    (_, _, _, on, off) = _notes_of(tracks[1])[0]
    per_second = TICKS_PER_BEAT * 90 / 60
    assert on == round(1.0 * per_second) and off == round(1.5 * per_second)
