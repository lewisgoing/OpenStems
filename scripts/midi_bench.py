"""Stem-to-MIDI benchmark (Phase 7, stage M0): transcribe, score, and build the baseline pack.

The data comes from scripts/midi_bench_data.py (default D:\\lew-stems\\bench). Run from
engine/, with mido and mir_eval added for the run only (they are not engine dependencies):

    uv run --no-sync --with mido==1.3.3 --with mir_eval==0.8.2 python ../scripts/midi_bench.py \\
        score [--sets guitarset,vocadito] [--methods yin,annotator2,melodyne,neuralnote]
    ... midi_bench.py pack     # audio for Melodyne and NeuralNote, with instructions

Methods:

- ``yin``: today's engine transcriber (``openstems.audio.analysis.track_notes``), the
  baseline to beat. Monophonic, so polyphonic guitar is expected to score low.
- ``annotator2``: vocadito's second annotator scored against the first, the human ceiling.
- ``melodyne``, ``neuralnote``: MIDI the owner exported for the pack, read from
  ``<bench>/baseline-pack/midi/<item>.<tool>.mid``. Each file is read with its own tempo map
  and shifted by one global offset found by matching onsets (Melodyne starts its export at the
  bar of the first note). The offset applied is reported.

Scores are mir_eval's note metrics at their defaults: onset within 50 ms and pitch within 50
cents; the offset variant also needs the offset within 20% of the note or 50 ms. Octave errors
are estimated notes left unmatched that sit an octave from a reference note at the same onset.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

DEFAULT_BENCH = Path(r"D:\lew-stems\bench")
Note = tuple[float, float, float, int]  # start s, end s, MIDI pitch (fractional), velocity

# The pack: a few items per set, chosen to vary player, style and singer.
PACK = {
    "guitarset": [
        "00_BN1-129-Eb_comp",
        "01_Jazz3-137-Eb_comp",
        "02_Funk2-119-G_comp",
        "03_SS1-68-E_comp",
        "01_BN3-119-G_solo",
        "02_Rock2-142-D_solo",
        "04_Funk1-114-Ab_solo",
    ],
    "vocadito": [
        "vocadito_1",
        "vocadito_5",
        "vocadito_9",
        "vocadito_14",
        "vocadito_22",
        "vocadito_31",
    ],
}
MELODYNE_ALGORITHM = {"guitarset": "Polyphonic Decay", "vocadito": "Melodic"}


@dataclass
class Item:
    set: str
    id: str
    kind: str  # the app's stem name this stands in for
    audio: Path
    reference: list[Note]
    extra: dict[str, list[Note]] = field(default_factory=dict)

    @property
    def name(self) -> str:
        return f"{self.set} - {self.id}"


# -- data sets ---------------------------------------------------------------------------


def load_guitarset(bench: Path, ids: list[str] | None) -> list[Item]:
    folder = bench / "guitarset"
    items = []
    for jams in sorted(folder.glob("*.jams")):
        if ids is not None and jams.stem not in ids:
            continue
        data = json.loads(jams.read_text("utf-8"))
        notes: list[Note] = []
        for ann in data["annotations"]:
            if ann["namespace"] != "note_midi":
                continue
            for obs in ann["data"]:
                start = float(obs["time"])
                notes.append((start, start + float(obs["duration"]), float(obs["value"]), 0))
        audio = folder / f"{jams.stem}_mic.wav"
        if audio.is_file():
            items.append(Item("guitarset", jams.stem, "guitar", audio, sorted(notes)))
    return items


def _vocadito_notes(path: Path) -> list[Note]:
    notes: list[Note] = []
    for row in csv.reader(path.read_text("utf-8").splitlines()):
        if len(row) < 3:
            continue
        start, hz, duration = float(row[0]), float(row[1]), float(row[2])
        notes.append((start, start + duration, 69 + 12 * np.log2(hz / 440.0), 0))
    return sorted(notes)


def load_vocadito(bench: Path, ids: list[str] | None) -> list[Item]:
    folder = bench / "vocadito"
    items = []
    for audio in sorted(
        folder.glob("Audio/vocadito_*.wav"), key=lambda p: int(p.stem.split("_")[1])
    ):
        if ids is not None and audio.stem not in ids:
            continue
        first = folder / "Annotations" / "Notes" / f"{audio.stem}_notesA1.csv"
        second = folder / "Annotations" / "Notes" / f"{audio.stem}_notesA2.csv"
        if not first.is_file():
            continue
        item = Item("vocadito", audio.stem, "vocals", audio, _vocadito_notes(first))
        if second.is_file():
            item.extra["annotator2"] = _vocadito_notes(second)
        items.append(item)
    return items


LOADERS: dict[str, Callable[[Path, list[str] | None], list[Item]]] = {
    "guitarset": load_guitarset,
    "vocadito": load_vocadito,
}


# -- methods -----------------------------------------------------------------------------


def method_yin(item: Item, bench: Path) -> list[Note] | None:
    from openstems.audio.analysis import track_notes
    from openstems.audio.decode import decode
    from openstems.pipeline.extras import _RANGES  # the engine's own ranges per stem

    low, high = _RANGES.get(item.kind, (55.0, 1600.0))
    audio = decode(item.audio)
    return [(s, e, float(n), v) for s, e, n, v in track_notes(audio, 44100, fmin=low, fmax=high)]


def method_annotator2(item: Item, bench: Path) -> list[Note] | None:
    return item.extra.get("annotator2")


def read_midi(path: Path) -> list[Note]:
    """Notes in seconds, read through the file's own tempo map. Pitch bends are ignored."""
    import mido

    notes: list[Note] = []
    open_notes: dict[tuple[int, int], tuple[float, int]] = {}
    now = 0.0
    for msg in mido.MidiFile(path):
        now += msg.time
        if msg.type == "note_on" and msg.velocity > 0:
            open_notes[(msg.channel, msg.note)] = (now, msg.velocity)
        elif msg.type in ("note_off", "note_on"):
            started = open_notes.pop((msg.channel, msg.note), None)
            if started is not None:
                notes.append((started[0], now, float(msg.note), started[1]))
    return sorted(notes)


def best_offset(reference: list[Note], estimate: list[Note], window: float = 6.0) -> float:
    """The single shift that lines up the most onsets of the same pitch, within ``window``."""
    if not reference or not estimate:
        return 0.0
    ref = np.array([(n[0], n[2]) for n in reference])
    diffs = []
    for start, _, pitch, _ in estimate:
        same = ref[np.abs(ref[:, 1] - pitch) < 0.5, 0] - start
        diffs.extend(same[np.abs(same) <= window])
    if not diffs:
        return 0.0
    values = np.array(diffs)
    bins = np.arange(-window, window + 0.01, 0.01)
    counts, edges = np.histogram(values, bins=bins)
    centre = edges[int(np.argmax(counts))] + 0.005
    near = values[np.abs(values - centre) <= 0.025]
    return float(np.median(near)) if near.size else float(centre)


def external(tool: str) -> Callable[[Item, Path], list[Note] | None]:
    def method(item: Item, bench: Path) -> list[Note] | None:
        path = bench / "baseline-pack" / "midi" / f"{item.name}.{tool}.mid"
        if not path.is_file():
            return None
        notes = read_midi(path)
        shift = best_offset(item.reference, notes)
        item.extra[f"{tool}-offset"] = [(shift, shift, 0.0, 0)]
        return [(s + shift, e + shift, p, v) for s, e, p, v in notes]

    return method


METHODS: dict[str, Callable[[Item, Path], list[Note] | None]] = {
    "yin": method_yin,
    "annotator2": method_annotator2,
    "melodyne": external("melodyne"),
    "neuralnote": external("neuralnote"),
}


# -- scoring -----------------------------------------------------------------------------


def _arrays(notes: list[Note]) -> tuple[np.ndarray, np.ndarray]:
    if not notes:
        return np.zeros((0, 2)), np.zeros(0)
    intervals = np.array([(s, max(e, s + 0.01)) for s, e, _, _ in notes])
    hz = 440.0 * 2 ** ((np.array([n[2] for n in notes]) - 69) / 12)
    return intervals, hz


def score(reference: list[Note], estimate: list[Note]) -> dict[str, float]:
    import mir_eval

    ref_i, ref_p = _arrays(reference)
    est_i, est_p = _arrays(estimate)
    row: dict[str, float] = {"ref_notes": len(reference), "est_notes": len(estimate)}
    if not estimate or not reference:
        row.update(onset_p=0.0, onset_r=0.0, onset_f=0.0, offset_f=0.0, octave_errors=0)
        return row
    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        ref_i, ref_p, est_i, est_p, offset_ratio=None
    )
    _, _, f_off, _ = mir_eval.transcription.precision_recall_f1_overlap(ref_i, ref_p, est_i, est_p)
    matched = {
        e
        for _, e in mir_eval.transcription.match_notes(
            ref_i, ref_p, est_i, est_p, offset_ratio=None
        )
    }
    octave = 0
    for k, (start, _, pitch, _) in enumerate(estimate):
        if k in matched:
            continue
        if any(
            abs(start - rs) <= 0.05 and abs(abs(pitch - rp) - 12) < 0.5
            for rs, _, rp, _ in reference
        ):
            octave += 1
    row.update(onset_p=p, onset_r=r, onset_f=f, offset_f=f_off, octave_errors=octave)
    return row


def cmd_score(args: argparse.Namespace) -> None:
    bench: Path = args.bench
    sets = [s for s in args.sets.split(",") if s]
    methods = [m for m in args.methods.split(",") if m]
    rows = []
    for set_name in sets:
        ids = PACK[set_name] if args.pack_only else None
        items = LOADERS[set_name](bench, ids)[: args.limit or None]
        for item in items:
            for name in methods:
                started = time.time()
                estimate = METHODS[name](item, bench)
                if estimate is None:
                    continue
                row = {"set": set_name, "item": item.id, "method": name}
                row.update(score(item.reference, estimate))
                row["seconds"] = round(time.time() - started, 2)
                offset = item.extra.get(f"{name}-offset")
                row["offset"] = round(offset[0][0], 3) if offset else ""
                rows.append(row)
                print(
                    f"{set_name:10} {item.id:28} {name:11} onset F {row['onset_f']:.3f}  "
                    f"+offset F {row['offset_f']:.3f}  notes {row['est_notes']}/{row['ref_notes']}"
                    + (f"  shift {row['offset']} s" if row["offset"] != "" else "")
                )
    if not rows:
        print("nothing scored")
        return
    out = bench / "results"
    out.mkdir(exist_ok=True)
    path = out / f"score-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nrows written to {path}\n")
    print("| Set | Method | Items | Onset P | Onset R | Onset F1 | +Offset F1 | Octave errors |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for set_name in sets:
        for name in methods:
            group = [r for r in rows if r["set"] == set_name and r["method"] == name]
            if not group:
                continue

            def mean(key: str, group: list[dict] = group) -> float:
                return float(np.mean([r[key] for r in group]))

            print(
                f"| {set_name} | {name} | {len(group)} | {mean('onset_p'):.3f} | "
                f"{mean('onset_r'):.3f} | {mean('onset_f'):.3f} | {mean('offset_f'):.3f} | "
                f"{sum(r['octave_errors'] for r in group)} |"
            )


# -- the baseline pack -------------------------------------------------------------------

PACK_README = """\
Baseline pack for the stem-to-MIDI benchmark (Phase 7, stage M0)
=================================================================

Each file in audio/ is one instrument on its own. For each one, export MIDI from Melodyne
and from NeuralNote, and save it in midi/ under the same name with the tool added:

    audio/guitarset - 00_BN1-129-Eb_comp.wav
    midi/guitarset - 00_BN1-129-Eb_comp.melodyne.mid
    midi/guitarset - 00_BN1-129-Eb_comp.neuralnote.mid

Melodyne: put the file on a track and let Melodyne detect it with the algorithm listed below.
Do not correct any notes: the benchmark measures the first pass, as the app's would be. Then
Settings > Save as MIDI (or drag the MIDI out). Where it starts the file does not matter: the
scorer finds the offset.

NeuralNote: load the file and export with the default settings.

When both are in midi/, run the scorer with --methods yin,melodyne,neuralnote.

Files and the Melodyne algorithm for each:
"""


def cmd_pack(args: argparse.Namespace) -> None:
    pack = args.bench / "baseline-pack"
    (pack / "audio").mkdir(parents=True, exist_ok=True)
    (pack / "midi").mkdir(exist_ok=True)
    lines = []
    for set_name, ids in PACK.items():
        for item in LOADERS[set_name](args.bench, ids):
            target = pack / "audio" / f"{item.name}.wav"
            if not target.exists():
                shutil.copyfile(item.audio, target)
            lines.append(f"  {target.name}  ->  {MELODYNE_ALGORITHM[set_name]}")
    (pack / "README.txt").write_text(PACK_README + "\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(lines)} files in {pack / 'audio'}; instructions in {pack / 'README.txt'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Stem-to-MIDI benchmark (Phase 7, M0).")
    parser.add_argument("--bench", type=Path, default=DEFAULT_BENCH)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("score", help="transcribe and score")
    s.add_argument("--sets", default="guitarset,vocadito")
    s.add_argument("--methods", default="yin,annotator2")
    s.add_argument("--limit", type=int, default=0, help="items per set (0: all)")
    s.add_argument("--pack-only", action="store_true", help="only the items in the pack")
    sub.add_parser("pack", help="copy the pack's audio and write its instructions")
    args = parser.parse_args()
    {"score": cmd_score, "pack": cmd_pack}[args.command](args)


if __name__ == "__main__":
    main()
