"""Standard MIDI File writing: format 0 for plain notes (``midi_bytes``, what the pipeline
writes today) and format 1 with parts, pitch bends and MPE (``midi_file_bytes``, Phase 7)."""

from __future__ import annotations

import struct
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from openstems.domain.notes import Note as NoteObject
from openstems.domain.notes import round_pitch

TICKS_PER_BEAT = 480
Note = tuple[float, float, int, int]  # start seconds, end seconds, midi note, velocity


def _varlen(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(out))


def midi_bytes(notes: list[Note], bpm: float = 120.0, name: str = "") -> bytes:
    """Notes as a format-0 MIDI file. Times are placed on the grid of ``bpm``, so the
    clip lines up with the project when the DAW runs at the same tempo."""
    bpm = bpm if bpm and bpm > 0 else 120.0
    ticks_per_second = TICKS_PER_BEAT * bpm / 60.0
    events: list[tuple[int, int, bytes]] = []  # tick, order (offs before ons), bytes
    for start, end, note, velocity in notes:
        on = max(0, round(start * ticks_per_second))
        off = max(on + 1, round(end * ticks_per_second))
        pitch = min(127, max(0, int(note)))
        events.append((on, 1, bytes([0x90, pitch, min(127, max(1, int(velocity)))])))
        events.append((off, 0, bytes([0x80, pitch, 0])))
    events.sort(key=lambda e: (e[0], e[1]))

    track = bytearray()
    if name:
        text = name.encode("utf-8")[:120]
        track += b"\x00\xff\x03" + _varlen(len(text)) + text
    tempo = round(60_000_000 / bpm)
    track += b"\x00\xff\x51\x03" + tempo.to_bytes(3, "big")
    last = 0
    for tick, _, data in events:
        track += _varlen(tick - last) + data
        last = tick
    track += b"\x00\xff\x2f\x00"
    header = b"MThd" + struct.pack(">IHHH", 6, 0, 1, TICKS_PER_BEAT)
    return header + b"MTrk" + struct.pack(">I", len(track)) + bytes(track)


def write_midi(path: Path, notes: list[Note], bpm: float = 120.0, name: str = "") -> None:
    path.write_bytes(midi_bytes(notes, bpm, name))


def read_midi_notes(data: bytes) -> tuple[list[Note], float]:
    """Parse a file written by :func:`midi_bytes` back into notes and its tempo."""
    if data[:4] != b"MThd":
        raise ValueError("not a MIDI file")
    division = struct.unpack(">H", data[12:14])[0]
    pos = 14
    if data[pos : pos + 4] != b"MTrk":
        raise ValueError("missing track")
    length = struct.unpack(">I", data[pos + 4 : pos + 8])[0]
    pos += 8
    end = pos + length
    tick = 0
    bpm = 120.0
    open_notes: dict[int, tuple[int, int]] = {}
    raw: list[tuple[int, int, int, int]] = []
    while pos < end:
        delta = 0
        while True:
            byte = data[pos]
            pos += 1
            delta = (delta << 7) | (byte & 0x7F)
            if not byte & 0x80:
                break
        tick += delta
        status = data[pos]
        if status == 0xFF:
            kind, size = data[pos + 1], data[pos + 2]
            body = data[pos + 3 : pos + 3 + size]
            pos += 3 + size
            if kind == 0x51:
                bpm = 60_000_000 / int.from_bytes(body, "big")
        elif status & 0xF0 == 0x90 and data[pos + 2] > 0:
            open_notes[data[pos + 1]] = (tick, data[pos + 2])
            pos += 3
        elif status & 0xF0 in (0x80, 0x90):
            started = open_notes.pop(data[pos + 1], None)
            if started is not None:
                raw.append((started[0], tick, data[pos + 1], started[1]))
            pos += 3
        else:
            pos += 3
    per_second = division * bpm / 60.0
    notes = [(a / per_second, b / per_second, n, v) for a, b, n, v in sorted(raw)]
    return notes, bpm


# -- format 1: parts, pitch bends and MPE (Phase 7, M1) -------------------------------------
#
# Three ways to carry pitch (docs/research/stem-to-midi.md, section 8):
#
# - "plain": notes only, each on the key nearest its pitch against the song's tuning. What
#   every DAW reads, FL Studio included, and the default.
# - "bend": one channel per part, the range declared with RPN 0 before any note, and each
#   note's offset and curve as pitch bend. For monophonic stems: a bend moves every note
#   sounding on the channel. FL Studio ignores the declared range and assumes +/-2.
# - "mpe": one pitched part on the lower zone (MIDI Polyphonic Expression, RP-053): the
#   configuration message on the master channel (1), each note on a member channel (2 to 16)
#   with its bend, CC74 and pressure sent before its Note On. Members bend +/-48, the master
#   +/-2. A note that finds all 15 members busy goes on the master channel as a plain note.

PITCH_MODES = ("plain", "bend", "mpe")
DRUM_CHANNEL = 9
MPE_MEMBERS = tuple(range(1, 16))
MPE_MEMBER_RANGE = 48
# Order of events on one tick: curve points of the note ending there, Note Offs, the next
# note's setup (bend, CC74, pressure), then Note Ons.
_CURVE, _OFF, _SETUP, _ON = 0, 1, 2, 3
_MAJOR_SHARPS = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1}
_PITCH_CLASS = {
    **{"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5},
    **{"F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11},
}
Event = tuple[int, int, bytes]  # tick, order within the tick, message


@dataclass
class Part:
    """One instrument in a format 1 file, on a track of its own."""

    name: str
    notes: Sequence[NoteObject]
    program: int = 0  # General MIDI program, 0 to 127; not sent for drums
    drums: bool = False


def key_signature(key: str | None) -> bytes | None:
    """The key signature meta event's data for a key as the engine writes it (``C``,
    ``F#``, ``Am``), spelled with fewer accidentals (C# major is written as Db). None when
    there is no key."""
    if not key:
        return None
    minor = key.endswith("m")
    pc = _PITCH_CLASS.get(key[:-1] if minor else key)
    if pc is None:
        return None
    sharps = _MAJOR_SHARPS[(pc + 3) % 12 if minor else pc]
    return bytes([sharps & 0xFF, 1 if minor else 0])


def _bend_value(semitones: float, bend_range: int) -> int:
    return min(16383, max(0, 8192 + round(semitones / bend_range * 8192)))


def _bend(channel: int, value: int) -> bytes:
    return bytes([0xE0 | channel, value & 0x7F, value >> 7])


def _cc(channel: int, number: int, value: int) -> bytes:
    return bytes([0xB0 | channel, number, value])


def _rpn(channel: int, number: int, msb: int, lsb: int = 0) -> list[bytes]:
    """Set registered parameter ``number`` to ``msb``/``lsb``, then select the null RPN so
    later data entry changes nothing."""
    return [
        _cc(channel, 101, number >> 7),
        _cc(channel, 100, number & 0x7F),
        _cc(channel, 6, msb),
        _cc(channel, 38, lsb),
        _cc(channel, 101, 127),
        _cc(channel, 100, 127),
    ]


def _track(events: list[Event], name: str = "") -> bytes:
    data = bytearray()
    if name:
        text = name.encode("utf-8")[:120]
        data += b"\x00\xff\x03" + _varlen(len(text)) + text
    last = 0
    for tick, _, message in sorted(events, key=lambda e: (e[0], e[1])):
        data += _varlen(tick - last) + message
        last = tick
    data += b"\x00\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(data)) + bytes(data)


def midi_file_bytes(
    parts: Sequence[Part],
    *,
    bpm: float = 120.0,
    key: str | None = None,
    pitch: str = "plain",
    bend_range: int = 2,
    tuning_cents: float = 0.0,
) -> bytes:
    """A format 1 file: a conductor track (tempo, 4/4, key signature), then one track per
    part. Times are placed on the grid of ``bpm`` as in :func:`midi_bytes`. Drum parts go
    on channel 10 as plain notes whatever ``pitch`` is."""
    if pitch not in PITCH_MODES:
        raise ValueError(f"pitch must be one of {PITCH_MODES}, not {pitch!r}")
    if not 1 <= bend_range <= 96:
        raise ValueError("the bend range must be 1 to 96 semitones")
    pitched = [p for p in parts if not p.drums]
    if pitch == "mpe" and (len(pitched) != 1 or len(parts) != 1):
        raise ValueError("an MPE file carries one pitched part and nothing else")
    bpm = bpm if bpm and bpm > 0 else 120.0
    per_second = TICKS_PER_BEAT * bpm / 60.0

    def tick(seconds: float) -> int:
        return max(0, round(seconds * per_second))

    conductor: list[Event] = [
        (0, 0, b"\xff\x51\x03" + round(60_000_000 / bpm).to_bytes(3, "big")),
        (0, 0, b"\xff\x58\x04\x04\x02\x18\x08"),
    ]
    signature = key_signature(key)
    if signature is not None:
        conductor.append((0, 0, b"\xff\x59\x02" + signature))
    tracks = [_track(conductor)]

    channels = [c for c in range(16) if c != DRUM_CHANNEL]
    for part in parts:
        events: list[Event] = []
        if part.drums:
            _plain_events(part.notes, DRUM_CHANNEL, tick, tuning_cents, events)
        elif pitch == "mpe":
            _mpe_events(part, tick, tuning_cents, events)
        else:
            channel = channels[pitched.index(part) % len(channels)]
            events.append((0, _SETUP, bytes([0xC0 | channel, part.program & 0x7F])))
            if pitch == "plain":
                _plain_events(part.notes, channel, tick, tuning_cents, events)
            else:
                events += [(0, _SETUP, m) for m in _rpn(channel, 0, bend_range)]
                for note in part.notes:
                    key_ = round_pitch(note.pitch, tuning_cents)[0]
                    on, off = _note(note, key_, channel, tick, events)
                    _curve(note, key_, channel, tick, on, off, bend_range, events)
        tracks.append(_track(events, part.name))
    header = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), TICKS_PER_BEAT)
    return header + b"".join(tracks)


def _note(
    note: NoteObject, key: int, channel: int, tick: Callable[[float], int], events: list[Event]
) -> tuple[int, int]:
    on = tick(note.start)
    off = max(on + 1, tick(note.end))
    velocity = min(127, max(1, int(note.velocity)))
    events.append((on, _ON, bytes([0x90 | channel, key, velocity])))
    events.append((off, _OFF, bytes([0x80 | channel, key, 0])))
    return on, off


def _plain_events(
    notes: Sequence[NoteObject],
    channel: int,
    tick: Callable[[float], int],
    tuning_cents: float,
    events: list[Event],
) -> None:
    for note in notes:
        if channel == DRUM_CHANNEL:
            key = min(127, max(0, round(note.pitch)))
        else:
            key = round_pitch(note.pitch, tuning_cents)[0]
        _note(note, key, channel, tick, events)


def _curve(
    note: NoteObject,
    key: int,
    channel: int,
    tick: Callable[[float], int],
    on: int,
    off: int,
    bend_range: int,
    events: list[Event],
) -> None:
    """The note's bend before its Note On, then a bend wherever the curve's 14-bit value
    changes, up to its Note Off."""
    offset = note.pitch - key
    last = _bend_value(offset + note.bend_at(0.0), bend_range)
    events.append((on, _SETUP, _bend(channel, last)))
    for t, semitones in note.bend:
        at = tick(note.start + t)
        value = _bend_value(offset + semitones, bend_range)
        if on < at < off and value != last:
            events.append((at, _CURVE, _bend(channel, value)))
            last = value


def _mpe_events(
    part: Part, tick: Callable[[float], int], tuning_cents: float, events: list[Event]
) -> None:
    master = 0
    setup = _rpn(master, 6, len(MPE_MEMBERS)) + _rpn(master, 0, 2)  # the zone, then its range
    for channel in MPE_MEMBERS:
        setup += _rpn(channel, 0, MPE_MEMBER_RANGE)
        setup.append(bytes([0xC0 | channel, part.program & 0x7F]))
    setup.append(bytes([0xC0 | master, part.program & 0x7F]))
    events += [(0, _SETUP, m) for m in setup]
    ends = dict.fromkeys(MPE_MEMBERS, -1)  # the tick each member's last note ended
    for note in sorted(part.notes, key=lambda n: (n.start, n.pitch)):
        key = round_pitch(note.pitch, tuning_cents)[0]
        on = tick(note.start)
        free = [c for c in MPE_MEMBERS if ends[c] <= on]
        if not free:  # all 15 members sounding: a plain note on the master channel
            _note(note, key, master, tick, events)
            continue
        channel = min(free, key=lambda c: (ends[c], c))  # the one released longest ago
        events.append((on, _SETUP, _cc(channel, 74, 64)))
        events.append((on, _SETUP, bytes([0xD0 | channel, 0])))
        on, off = _note(note, key, channel, tick, events)
        ends[channel] = off
        _curve(note, key, channel, tick, on, off, MPE_MEMBER_RANGE, events)


def read_tracks(data: bytes) -> tuple[int, int, list[list[tuple[int, bytes]]]]:
    """Any Standard MIDI File as (format, ticks per beat, tracks), each track a list of
    (absolute tick, message) with running status expanded and SysEx skipped."""
    if data[:4] != b"MThd":
        raise ValueError("not a MIDI file")
    fmt, count, division = struct.unpack(">HHH", data[8:14])
    pos = 8 + struct.unpack(">I", data[4:8])[0]
    tracks: list[list[tuple[int, bytes]]] = []

    def varlen() -> int:
        nonlocal pos
        value = 0
        while True:
            byte = data[pos]
            pos += 1
            value = (value << 7) | (byte & 0x7F)
            if not byte & 0x80:
                return value

    for _ in range(count):
        if data[pos : pos + 4] != b"MTrk":
            raise ValueError("missing track")
        end = pos + 8 + struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        pos += 8
        tick, status = 0, 0
        events: list[tuple[int, bytes]] = []
        while pos < end:
            tick += varlen()
            if data[pos] & 0x80:
                status = data[pos]
                pos += 1
            if status == 0xFF:
                kind = data[pos]
                pos += 1
                size = varlen()
                events.append((tick, bytes([0xFF, kind]) + data[pos : pos + size]))
                pos += size
            elif status in (0xF0, 0xF7):
                pos += varlen()
            else:
                width = 1 if status & 0xF0 in (0xC0, 0xD0) else 2
                events.append((tick, bytes([status]) + data[pos : pos + width]))
                pos += width
        tracks.append(events)
        pos = end
    return fmt, division, tracks
