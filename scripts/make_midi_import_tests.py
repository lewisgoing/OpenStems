"""Write small MIDI files that show how a DAW imports pitch bend, MPE and a tempo map.

Phase 7, stage M0 (docs/research/stem-to-midi.md, section 8). The files are opened by hand
in FL Studio, Logic and Live; README.txt in the output folder says what to look for in each.
No dependencies: the bytes are written here, so the files do not depend on the engine's own
MIDI writer, which they are meant to inform.

    python scripts/make_midi_import_tests.py [OUTPUT_FOLDER]
"""

from __future__ import annotations

import math
import struct
import sys
from pathlib import Path

TPQ = 480  # ticks per quarter note
BAR = 4 * TPQ  # 4/4 throughout
DEFAULT_OUT = Path(r"D:\lew-stems\midi-import-tests")


def _varlen(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(out))


class Track:
    """Events in the order they were added; ties at one tick keep that order."""

    def __init__(self, name: str = "") -> None:
        self.events: list[tuple[int, int, bytes]] = []
        if name:
            self.meta(0, 0x03, name.encode("utf-8"))

    def add(self, tick: int, data: bytes) -> None:
        self.events.append((tick, len(self.events), data))

    def meta(self, tick: int, kind: int, body: bytes) -> None:
        self.add(tick, bytes([0xFF, kind]) + _varlen(len(body)) + body)

    def tempo(self, tick: int, bpm: float) -> None:
        self.meta(tick, 0x51, round(60_000_000 / bpm).to_bytes(3, "big"))

    def time_signature(self, tick: int) -> None:
        self.meta(tick, 0x58, bytes([4, 2, 24, 8]))  # 4/4

    def key_signature(self, tick: int, sharps: int, minor: bool) -> None:
        self.meta(tick, 0x59, bytes([sharps & 0xFF, 1 if minor else 0]))

    def cc(self, tick: int, ch: int, number: int, value: int) -> None:
        self.add(tick, bytes([0xB0 | ch, number, value]))

    def note(self, start: int, end: int, ch: int, key: int, velocity: int = 100) -> None:
        self.add(start, bytes([0x90 | ch, key, velocity]))
        self.add(end, bytes([0x80 | ch, key, 0]))

    def bend(self, tick: int, ch: int, value: int) -> None:
        value = max(0, min(16383, value))
        self.add(tick, bytes([0xE0 | ch, value & 0x7F, value >> 7]))

    def pressure(self, tick: int, ch: int, value: int) -> None:
        self.add(tick, bytes([0xD0 | ch, max(0, min(127, value))]))

    def bend_range(self, tick: int, ch: int, semitones: int) -> int:
        """RPN 0 (pitch-bend sensitivity), then RPN null. One message per tick, since older
        Logic versions may reorder controllers that share a tick. Returns the next free tick."""
        for number, value in ((101, 0), (100, 0), (6, semitones), (38, 0), (101, 127), (100, 127)):
            self.cc(tick, ch, number, value)
            tick += 1
        return tick

    def encode(self) -> bytes:
        body = bytearray()
        last = 0
        ordered = sorted(self.events, key=lambda e: (e[0], e[1]))
        for tick, _, data in ordered:
            body += _varlen(tick - last) + data
            last = tick
        body += b"\x00\xff\x2f\x00"
        return b"MTrk" + struct.pack(">I", len(body)) + bytes(body)


def bend_value(semitones: float, bend_range: float) -> int:
    return 8192 + round(semitones / bend_range * 8192)


def write(path: Path, tracks: list[Track]) -> None:
    fmt = 0 if len(tracks) == 1 else 1
    header = b"MThd" + struct.pack(">IHHH", 6, fmt, len(tracks), TPQ)
    path.write_bytes(header + b"".join(t.encode() for t in tracks))


def conductor(name: str, bpm: float = 120.0) -> Track:
    t = Track(name)
    t.tempo(0, bpm)
    t.time_signature(0)
    return t


# -- files 1 to 3: one note, one bend, three declared ranges -------------------------------


def bend_test(path: Path, title: str, declared: int, rise: float, refs: list[int]) -> None:
    """C4 held for two bars from bar 2; its bend rises by ``rise`` semitones against the
    ``declared`` range. Plain reference notes follow from bar 5, one per possible reading."""
    song = conductor(title)
    lead = Track("Lead")
    lead.bend_range(0, 0, declared)
    lead.bend(10, 0, 8192)
    start, end = BAR, 3 * BAR
    lead.note(start, end, 0, 60)
    ramp_from, ramp_to = start + TPQ, start + 3 * TPQ
    for tick in range(ramp_from, ramp_to + 1, 20):
        lead.bend(tick, 0, bend_value(rise * (tick - ramp_from) / (ramp_to - ramp_from), declared))
    lead.bend(end + 10, 0, 8192)
    for i, key in enumerate(refs):
        at = 4 * BAR + 2 * i * BAR
        lead.note(at, at + BAR, 0, key)
    write(path, [song, lead])


# -- file 4: MPE --------------------------------------------------------------------------


def mpe_tracks(split: bool) -> list[Track]:
    """Lower zone, 15 member channels (2-16). Four overlapping notes on channels 2-5, each
    with its own bend, CC74 and channel pressure, set before its Note On."""
    song = conductor("MPE test")
    master = Track("Zone master")
    # MPE Configuration Message, as in RP-053 section 2.1.2: reset, then RPN 00 06 = 15.
    for i, (number, value) in enumerate(((121, 0), (100, 6), (101, 0), (6, 15))):
        master.cc(i, 0, number, value)
    tick = master.bend_range(4, 0, 2)
    members = [Track(f"Note channel {ch + 1}") if split else master for ch in range(1, 5)]
    for ch in range(1, 16):
        owner = members[ch - 1] if split and ch <= 4 else master
        tick = owner.bend_range(tick, ch, 48)

    def voice(track: Track, ch: int, key: int, start: int, shape: str) -> None:
        end = 3 * BAR
        track.bend(start - 3, ch, 8192)
        track.cc(start - 2, ch, 74, 64)
        track.pressure(start - 1, ch, 64)
        track.note(start, end, ch, key)
        for t in range(start + 10, end, 10):
            seconds = (t - start) / TPQ * 0.5  # 120 BPM: a quarter note is 0.5 s
            frac = (t - start) / (end - start)
            if shape == "vibrato":
                semis = 0.3 * math.sin(2 * math.pi * 5.5 * seconds)
            elif shape == "up":
                semis = 2.0 * min(1.0, max(0.0, (frac - 0.25) / 0.5))
            elif shape == "down":
                semis = -1.0 * min(1.0, max(0.0, (frac - 0.25) / 0.5))
            else:
                semis = 0.0
            track.bend(t, ch, bend_value(semis, 48))
            if t % 40 == 0:
                track.cc(t, ch, 74, round(20 + 90 * frac) if shape == "static" else 64)
                swell = round(30 + 90 * math.sin(math.pi * frac))
                track.pressure(t, ch, swell)
        track.bend(end + 10, ch, 8192)

    voice(members[0], 1, 60, BAR, "vibrato")  # C4 on channel 2: vibrato
    voice(members[1], 2, 64, BAR + TPQ, "up")  # E4 on channel 3: slides up 2 semitones
    voice(members[2], 3, 67, BAR + 2 * TPQ, "down")  # G4 on channel 4: slides down 1
    voice(members[3], 4, 71, BAR + 3 * TPQ, "static")  # B4 on channel 5: CC74 sweep
    if split:
        return [song, master, *members]
    for _, _, data in sorted(song.events, key=lambda e: (e[0], e[1])):
        if data[:2] != b"\xff\x03":
            master.add(0, data)
    return [master]


# -- file 5: two voices on two channels ----------------------------------------------------


def two_voice_tracks(split: bool) -> list[Track]:
    song = conductor("Two voices")
    melody = Track("Melody (channel 1)")
    bass = Track("Bass (channel 2)") if split else melody
    melody.bend_range(0, 0, 2)
    melody.bend(10, 0, 8192)
    for i, key in enumerate((72, 74, 76, 77)):
        melody.note(BAR + i * TPQ, BAR + (i + 1) * TPQ, 0, key)
    # The last melody note slides up one semitone before it ends.
    last = BAR + 3 * TPQ
    for t in range(last + 120, last + TPQ, 20):
        melody.bend(t, 0, bend_value((t - last - 120) / (TPQ - 120), 2))
    melody.bend(BAR + 4 * TPQ + 10, 0, 8192)
    for i, key in enumerate((48, 43)):
        bass.note(BAR + i * 2 * TPQ, BAR + (i + 1) * 2 * TPQ, 1, key)
    if split:
        return [song, melody, bass]
    for _, _, data in sorted(song.events, key=lambda e: (e[0], e[1])):
        if data[:2] != b"\xff\x03":
            melody.add(0, data)
    return [melody]


# -- file 6: tempo map and key signature ---------------------------------------------------


def tempo_map_tracks() -> list[Track]:
    song = conductor("Tempo map and key", bpm=100.0)
    song.key_signature(0, sharps=1, minor=True)  # E minor
    song.tempo(4 * BAR, 130.0)  # bar 5
    clicks = Track("Beats")
    for beat in range(8 * 4):
        downbeat = beat % 4 == 0
        start = beat * TPQ
        clicks.note(start, start + TPQ // 2, 0, 52 if downbeat else 59, 120 if downbeat else 70)
    return [song, clicks]


README = """\
MIDI import tests for stem to MIDI (Phase 7, stage M0)
=======================================================

Written by scripts/make_midi_import_tests.py. Each file asks one question. Open each in FL
Studio three ways: File > Import > MIDI file, dragged onto the Channel Rack, and dragged into
the Piano roll. Put any instrument on the channel and listen; where bends land is easiest to
see in the Event Editor (channel pitch). Note what happens; a sentence per file is enough.

Every file is 4/4. All but file 6 run at 120 BPM.

1-bend-range-2.mid
  C4 for two bars from bar 2. It declares a bend range of +/-2 (RPN 0) and bends up to the
  top of that range: it should end on D4. Bar 5 plays a plain D4 to compare.
  Q: Does the bend come through? Does it reach D4? Where does it land (channel pitch events,
     note slides, nowhere)?

2-bend-range-12.mid
  The same bend data as file 1, but the file declares +/-12. If FL reads the declared range,
  the note rises an octave to C5 (the plain note at bar 5). If FL always assumes +/-2, it
  rises only to D4 (the plain note at bar 7), exactly like file 1.
  Q: C5 or D4?

3-bend-range-48.mid
  Declares +/-48 (the MPE range) and bends up 7 semitones. Read correctly, it ends on G4 (the
  plain note at bar 5). Assuming +/-2, it barely moves (bar 7 plays plain C4).
  Q: G4, or almost no change?

4-mpe-type0.mid and 4-mpe-type1.mid
  MPE, as Live, Logic and Bitwig expect it: four overlapping notes on MIDI channels 2-5:
  - C4 with vibrato;
  - E4 sliding up 2 semitones;
  - G4 sliding down 1;
  - B4 steady with a brightness (CC74) sweep.
  Each also has a pressure swell. Type 0 has one track; type 1 has a track per channel.
  FL Studio: import each with "Create one channel per track" on, then off.
    Q: How many channels appear? Does each note keep its own bend?
  Logic (on the Mac) and Live: open both with an MPE instrument (Logic: Alchemy or Sculpture
  in MPE mode; Live: any MPE-capable device; in Live look at the clip's Note Expression tab).
    Q: Does each note keep its own pitch curve? Are the slides the right size (2 up, 1 down)?

5-two-voices-type0.mid and 5-two-voices-type1.mid
  A melody on channel 1 (its last note slides up a semitone) and a bass on channel 2.
  Q: How does FL split them (one channel or two)? Does the slide stay with the melody only?

6-tempo-map-key.mid
  Eight bars of beats: a low E on each downbeat, a quieter B on the other beats. 100 BPM for
  four bars, then 130 BPM from bar 5. Key signature E minor.
  Q: Does FL take the tempo change (the project tempo, or a tempo automation clip)? Do the
     downbeat notes stay on the bar lines after it? Is the key shown anywhere?
"""


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out.mkdir(parents=True, exist_ok=True)
    bend_test(out / "1-bend-range-2.mid", "Bend range 2", 2, 2.0, [62])
    bend_test(out / "2-bend-range-12.mid", "Bend range 12", 12, 12.0, [72, 62])
    bend_test(out / "3-bend-range-48.mid", "Bend range 48", 48, 7.0, [67, 60])
    write(out / "4-mpe-type0.mid", mpe_tracks(split=False))
    write(out / "4-mpe-type1.mid", mpe_tracks(split=True))
    write(out / "5-two-voices-type0.mid", two_voice_tracks(split=False))
    write(out / "5-two-voices-type1.mid", two_voice_tracks(split=True))
    write(out / "6-tempo-map-key.mid", tempo_map_tracks())
    (out / "README.txt").write_text(README, encoding="utf-8")
    print(f"wrote 8 MIDI files and README.txt to {out}")


if __name__ == "__main__":
    main()
