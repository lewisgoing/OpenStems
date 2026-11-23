"""A minimal Standard MIDI File writer and reader (format 0, one track)."""

from __future__ import annotations

import struct
from pathlib import Path

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
