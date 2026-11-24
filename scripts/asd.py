"""Read and write Ableton Live's .asd analysis files (as Live 13 beta writes them).

Research, not part of the app: docs/research/ableton-asd.md describes the format as far as it
is known. `python scripts/asd.py check FILE...` parses each file and writes it back, and fails
unless the bytes are the same. Standard library only.
"""

from __future__ import annotations

import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

MAGIC = b"\xab\x1e\x56\x78"
DBL_MAX = 1.7976931348623157e308
INT_MIN = -(2**31)


class Reader:
    def __init__(self, data: bytes, pos: int = 0) -> None:
        self.d = data
        self.p = pos

    def take(self, fmt: str):
        size = struct.calcsize("<" + fmt)
        value = struct.unpack_from("<" + fmt, self.d, self.p)
        self.p += size
        return value[0] if len(value) == 1 else value

    def raw(self, n: int) -> bytes:
        value = self.d[self.p : self.p + n]
        self.p += n
        return value

    def name(self) -> str:
        n = self.take("B")
        return self.raw(n).decode("ascii")


class Writer:
    def __init__(self) -> None:
        self.b = bytearray()

    def put(self, fmt: str, *values) -> None:
        self.b += struct.pack("<" + fmt, *values)

    def raw(self, data: bytes) -> None:
        self.b += data

    def name(self, text: str) -> None:
        self.put("B", len(text))
        self.b += text.encode("ascii")


# ---- the parts with known layout -------------------------------------------------------


@dataclass
class Marker:
    id: int
    sec: float
    beat: float


@dataclass
class Level:
    id: int
    values: bytes  # f32 per channel per bin, interleaved


@dataclass
class AufTakt:
    chunk: bytes = b""  # PreprocessedDataChunk, opaque
    tempo: float = DBL_MAX  # UnbiasedTempoEstimate; DBL_MAX when unset
    is_set: int = 0
    version: int = INT_MIN


@dataclass
class Clip:
    loop_start: float = 0.0
    loop_end: float = 0.0
    sample_offset: float = 0.0
    hidden_loop_start: float = 0.0
    hidden_loop_end: float = 0.0
    out_marker: float = 0.0
    sync: int = 1
    hiq: int = 0
    fade: int = 1
    is_warped: int = 1
    floats_a: tuple = (1.0, 0.0, 0.0, 0.0)  # SampleVolume, VelocityAmount, PitchCoarse, PitchFine
    warp_mode: int = 0
    transient_resolution: int = 6
    floats_b: tuple = (30.0, 65.0, 25.0)  # GranularityTones, GranularityTexture, FluctuationTexture
    transient_loop_mode: int = 2
    floats_c: tuple = (100.0, 100.0, 128.0)  # TransientEnvelope, ComplexProFormants, ComplexProEnvelope
    time_signature: tuple = (4.0, 4.0, 0.0)
    color: int = -1
    markers_header: int = 0
    markers: list[Marker] = field(default_factory=list)
    markers_generated: int = 0
    launch_mode: int = 0
    loop_on: int = 1
    launch_quantisation: int = 0
    onset_positions: list[int] = field(default_factory=list)
    onset_energies: list[float] = field(default_factory=list)
    onsets_set: int = 0
    onsets_version: int = 5
    user_onsets_header: int = 0
    user_onsets_class: str = "OnsetEvent"
    has_user_onsets: int = 0
    auftakt: AufTakt = field(default_factory=AufTakt)
    extra_length: int = 0
    original_file_size: int = 0
    levels_header: int = 3
    levels: list[Level] = field(default_factory=list)
    samples_per_bin_log2: int = 7
    channel_count: int = 2
    overview_version: int = 2


def read_items(r: Reader, cls: str):
    """List items: 00, class name, u32 id, fields. A 00 00 ends the list."""
    items = []
    while True:
        tag = r.take("B")
        assert tag == 0, f"list item tag {tag} at {r.p - 1:#x}"
        name = r.name()
        if name == "":
            return items
        assert name == cls, f"{name} != {cls}"
        items.append(r.take("I"))


def read_clip(r: Reader) -> Clip:
    c = Clip()
    (c.loop_start, c.loop_end, c.sample_offset, c.hidden_loop_start, c.hidden_loop_end, c.out_marker) = r.take("6d")
    c.sync, c.hiq, c.fade, c.is_warped = r.take("4B")
    c.floats_a = r.take("4f")
    c.warp_mode, c.transient_resolution = r.take("2i")
    c.floats_b = r.take("3f")
    c.transient_loop_mode = r.take("i")
    c.floats_c = r.take("3f")
    c.time_signature = r.take("2fd")
    c.color = r.take("i")
    c.markers_header = r.take("I")
    while True:
        assert r.take("B") == 0
        name = r.name()
        if name == "":
            break
        assert name == "WarpMarker"
        mid = r.take("I")
        sec, beat = r.take("2d")
        c.markers.append(Marker(mid, sec, beat))
    c.markers_generated = r.take("B")
    c.launch_mode = r.take("i")
    c.loop_on = r.take("B")
    c.launch_quantisation = r.take("i")
    n = r.take("I")
    c.onset_positions = list(r.take(f"{n}I")) if n else []
    n = r.take("I")
    c.onset_energies = list(r.take(f"{n}f")) if n else []
    c.onsets_set = r.take("B")
    c.onsets_version = r.take("i")
    c.user_onsets_header = r.take("I")
    assert r.take("B") == 0
    c.user_onsets_class = r.name()
    c.has_user_onsets = r.take("B")
    c.auftakt = read_auftakt(r)
    c.extra_length = r.take("i")
    c.original_file_size = r.take("I")
    c.levels_header = r.take("I")
    while True:
        assert r.take("B") == 0
        name = r.name()
        if name == "":
            break
        assert name == "SampleOverViewLevel"
        lid = r.take("I")
        words = r.take("I")
        c.levels.append(Level(lid, r.raw(words * 2)))
    c.samples_per_bin_log2, c.channel_count, c.overview_version = r.take("3i")
    return c


def read_auftakt(r: Reader) -> AufTakt:
    a = AufTakt()
    n = r.take("I")
    a.chunk = r.raw(n)
    a.tempo = r.take("d")
    a.is_set = r.take("B")
    a.version = r.take("i")
    return a


def write_auftakt(w: Writer, a: AufTakt) -> None:
    w.put("I", len(a.chunk))
    w.raw(a.chunk)
    w.put("dBi", a.tempo, a.is_set, a.version)


def write_clip(w: Writer, c: Clip) -> None:
    w.put("6d", c.loop_start, c.loop_end, c.sample_offset, c.hidden_loop_start, c.hidden_loop_end, c.out_marker)
    w.put("4B", c.sync, c.hiq, c.fade, c.is_warped)
    w.put("4f", *c.floats_a)
    w.put("2i", c.warp_mode, c.transient_resolution)
    w.put("3f", *c.floats_b)
    w.put("i", c.transient_loop_mode)
    w.put("3f", *c.floats_c)
    w.put("2fd", *c.time_signature)
    w.put("i", c.color)
    w.put("I", c.markers_header)
    for m in c.markers:
        w.put("B", 0)
        w.name("WarpMarker")
        w.put("I2d", m.id, m.sec, m.beat)
    w.put("BB", 0, 0)
    w.put("BiBi", c.markers_generated, c.launch_mode, c.loop_on, c.launch_quantisation)
    w.put("I", len(c.onset_positions))
    if c.onset_positions:
        w.put(f"{len(c.onset_positions)}I", *c.onset_positions)
    w.put("I", len(c.onset_energies))
    if c.onset_energies:
        w.put(f"{len(c.onset_energies)}f", *c.onset_energies)
    w.put("Bi", c.onsets_set, c.onsets_version)
    w.put("I", c.user_onsets_header)
    w.put("B", 0)
    w.name(c.user_onsets_class)
    w.put("B", c.has_user_onsets)
    write_auftakt(w, c.auftakt)
    w.put("iI", c.extra_length, c.original_file_size)
    w.put("I", c.levels_header)
    for lv in c.levels:
        w.put("B", 0)
        w.name("SampleOverViewLevel")
        w.put("II", lv.id, len(lv.values) // 2)
        w.raw(lv.values)
    w.put("BB", 0, 0)
    w.put("3i", c.samples_per_bin_log2, c.channel_count, c.overview_version)


# ---- the whole file --------------------------------------------------------------------


@dataclass
class Section:
    """One serialized object: the magic, a version byte and word, the root reference, its
    schema (kept as bytes) and its data."""

    kind: int
    version: int
    root: str
    root_id: int
    schema: bytes
    data: object


@dataclass
class AsdFile:
    head: bytes  # 06 49, the integer table and what follows it, opaque
    saved_clip: int  # 1 after Save Default Clip
    sections: list[Section]


# The schema of each root ends with its last field: the tag that follows that field's name.
SCHEMA_END = {
    "SampleData": "InterleavedBinData".encode("utf-16-le") + b"\x32",
    "AufTaktData": "Version".encode("utf-16-le") + b"\x11",
}


def parse(data: bytes) -> AsdFile:
    first = data.index(MAGIC)
    head, saved = data[: first - 1], data[first - 1]
    r = Reader(data, first)
    sections = []
    while r.p < len(data):
        assert r.raw(4) == MAGIC, f"magic at {r.p - 4:#x}"
        kind = r.take("B")
        version = r.take("I")
        assert r.take("B") == 0
        root = r.name()
        root_id = r.take("I")
        end_mark = SCHEMA_END[root]
        if root == "SampleData":
            # The last schema field of a file is the last one; find the final occurrence.
            end = data.index(end_mark, r.p) + len(end_mark)
        else:
            end = data.index(end_mark, r.p) + len(end_mark)
        schema = data[r.p : end]
        r.p = end
        body = read_clip(r) if root == "SampleData" else read_auftakt(r)
        sections.append(Section(kind, version, root, root_id, schema, body))
    return AsdFile(head, saved, sections)


def serialize(f: AsdFile) -> bytes:
    w = Writer()
    w.raw(f.head)
    w.put("B", f.saved_clip)
    for s in f.sections:
        w.raw(MAGIC)
        w.put("BIB", s.kind, s.version, 0)
        w.name(s.root)
        w.put("I", s.root_id)
        w.raw(s.schema)
        if s.root == "SampleData":
            write_clip(w, s.data)  # type: ignore[arg-type]
        else:
            write_auftakt(w, s.data)  # type: ignore[arg-type]
    return bytes(w.b)


def check(paths: list[str]) -> int:
    bad = 0
    for p in paths:
        data = Path(p).read_bytes()
        try:
            out = serialize(parse(data))
        except Exception as error:  # noqa: BLE001 - a research tool reports and goes on
            print(f"FAIL {p}: {error}")
            bad += 1
            continue
        same = out == data
        print(("ok  " if same else "DIFF") + f" {p} ({len(data)} bytes)")
        if not same:
            bad += 1
            at = next((i for i in range(min(len(out), len(data))) if out[i] != data[i]), min(len(out), len(data)))
            print(f"     first difference at {at:#x}, sizes {len(data)} vs {len(out)}")
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "check":
        sys.exit(check(sys.argv[2:]))
    print(__doc__)
