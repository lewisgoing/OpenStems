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


# Slakh2100: the app's separated stems scored against Slakh's MIDI, next to Slakh's own clean
# stems ("oracle"). Slakh's instruments are grouped the way the app's recipes split them.
SLAKH_CLASS = {"Bass": "bass", "Guitar": "guitar", "Piano": "piano"}  # the rest: "other"
DRUM_PARTS = {  # General MIDI drum notes per DrumSep part
    "kick": {35, 36},
    "snare": {37, 38, 40},
    "toms": {41, 43, 45, 47, 48, 50},
    "hh": {42, 44, 46},
    "ride": {51, 53, 59},
    "crash": {49, 52, 55, 57},
}
DRUM_KINDS = {"drums", *DRUM_PARTS}
RECIPE_FOR = {
    **{kind: "full-song" for kind in ("drums", "bass", "guitar", "piano", "other")},
    **{part: "drum-kit" for part in DRUM_PARTS},
}
SLAKH_CONDITIONS = ["separated", "oracle"]


def slakh_songs(bench: Path) -> list[Path]:
    from midi_bench_data import slakh_complete

    folder = bench / "slakh"
    return sorted(p for p in folder.glob("Track*") if slakh_complete(p)) if folder.is_dir() else []


def _slakh_class(stem: dict) -> str:
    return "drums" if stem.get("is_drum") else SLAKH_CLASS.get(stem.get("inst_class", ""), "other")


def _slakh_meta(song: Path) -> dict:
    import yaml

    return yaml.safe_load((song / "metadata.yaml").read_text("utf-8"))


def slakh_reference(song: Path, meta: dict) -> dict[str, list[Note]]:
    refs: dict[str, list[Note]] = {}
    for sid, stem in sorted(meta["stems"].items()):
        if not stem.get("audio_rendered"):
            continue
        notes = read_midi(song / "MIDI" / f"{sid}.mid")
        kind = _slakh_class(stem)
        refs.setdefault(kind, []).extend(notes)
        if kind == "drums":
            for part, keys in DRUM_PARTS.items():
                refs.setdefault(part, []).extend(n for n in notes if int(n[2]) in keys)
    return {kind: sorted(notes) for kind, notes in refs.items() if notes}


def _oracle_audio(bench: Path, song: Path, meta: dict, kind: str) -> Path | None:
    """Slakh's own stems of one class, summed once and kept. None for drum parts: Slakh renders
    the kit as one stem."""
    target = bench / "slakh-oracle" / song.name / f"{kind}.wav"
    if target.is_file():
        return target
    if kind in DRUM_PARTS:
        return None
    import soundfile as sf

    total: np.ndarray | None = None
    rate = 44100
    for sid, stem in meta["stems"].items():
        path = song / "stems" / f"{sid}.flac"
        if not stem.get("audio_rendered") or _slakh_class(stem) != kind or not path.is_file():
            continue
        audio, rate = sf.read(path, dtype="float32", always_2d=True)
        if total is None:
            total = audio
        else:
            length = max(total.shape[0], audio.shape[0])
            total = np.pad(total, ((0, length - total.shape[0]), (0, 0)))
            total[: audio.shape[0]] += audio
    if total is None:
        return None
    target.parent.mkdir(parents=True, exist_ok=True)
    sf.write(target, total, rate, subtype="FLOAT")
    return target


def _separated_audio(bench: Path, song: Path, kind: str) -> Path | None:
    from openstems.pipeline.run import read_manifest

    folder = bench / "runs" / "slakh" / song.name / RECIPE_FOR.get(kind, "full-song")
    manifest = read_manifest(folder)
    if not manifest or not manifest.get("complete"):
        return None
    for stem in manifest.get("stems", []):
        if stem["name"] == kind:
            return folder / stem["file"]
    return None


def load_slakh(bench: Path, ids: list[str] | None) -> list[Item]:
    items = []
    for song in slakh_songs(bench):
        if ids is not None and song.name not in ids:
            continue
        meta = _slakh_meta(song)
        for kind, notes in slakh_reference(song, meta).items():
            for condition in SLAKH_CONDITIONS:
                if condition == "separated":
                    audio = _separated_audio(bench, song, kind)
                else:
                    audio = _oracle_audio(bench, song, meta, kind)
                if audio is not None:
                    item_id = f"{song.name}/{kind}/{condition}"
                    items.append(Item("slakh", item_id, kind, audio, notes))
    return items


LOADERS: dict[str, Callable[[Path, list[str] | None], list[Item]]] = {
    "guitarset": load_guitarset,
    "vocadito": load_vocadito,
    "slakh": load_slakh,
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


# Pitch trackers compared on equal terms: each one's pitch and voicing go through the same
# note segmentation as today's engine (semitone runs, a 5-frame median, 80 ms minimum), so
# only the tracker differs. ``swiftf0-notes`` instead uses SwiftF0's own segmenter (MIT).


def notes_from_f0(times: np.ndarray, hz: np.ndarray, voiced: np.ndarray) -> list[Note]:
    if times.size < 3:
        return []
    hop = float(np.median(np.diff(times)))
    safe = np.where(voiced & (hz > 0), hz, 1.0)
    midi = np.where(voiced & (hz > 0), np.round(69 + 12 * np.log2(safe / 440.0)), -1).astype(int)
    padded = np.pad(midi, 2, mode="edge")
    midi = np.median(np.lib.stride_tricks.sliding_window_view(padded, 5), axis=1).astype(int)
    min_frames = max(1, round(0.08 / hop))
    notes: list[Note] = []
    start = 0
    for i in range(1, midi.size + 1):
        if i == midi.size or midi[i] != midi[start]:
            if midi[start] >= 0 and i - start >= min_frames:
                notes.append(
                    (float(times[start]), float(times[i - 1] + hop), float(midi[start]), 0)
                )
            start = i
    merged: list[Note] = []
    for note in notes:
        if merged and merged[-1][2] == note[2] and note[0] - merged[-1][1] <= 2 * hop:
            prev = merged.pop()
            merged.append((prev[0], note[1], prev[2], 0))
        else:
            merged.append(note)
    return merged


def _mono(item: Item, rate: int) -> np.ndarray:
    from openstems.audio.decode import decode

    return decode(item.audio, sample_rate=rate).mean(axis=0)


def method_pyin(item: Item, bench: Path) -> list[Note] | None:
    import librosa

    from openstems.pipeline.extras import _RANGES

    low, high = _RANGES.get(item.kind, (55.0, 1600.0))
    rate, hop = 22050, 256
    f0, voiced, _ = librosa.pyin(_mono(item, rate), fmin=low, fmax=high, sr=rate, hop_length=hop)
    times = np.arange(f0.size) * hop / rate
    return notes_from_f0(times, np.nan_to_num(f0), voiced)


def _swiftf0(item: Item):
    from swift_f0 import SwiftF0

    return SwiftF0(threads=2).detect(_mono(item, 16000), 16000)  # kept light on this PC


def method_swiftf0(item: Item, bench: Path) -> list[Note] | None:
    result = _swiftf0(item)
    return notes_from_f0(result.timestamps, result.pitch_hz, result.confidence >= 0.5)


def method_swiftf0_notes(item: Item, bench: Path) -> list[Note] | None:
    from swift_f0 import segment_notes

    notes = segment_notes(_swiftf0(item))
    return [(n.start, n.end, 69 + 12 * float(np.log2(n.pitch_hz / 440.0)), 0) for n in notes]


def method_crepe(item: Item, bench: Path) -> list[Note] | None:
    import torch
    import torchcrepe

    from openstems.pipeline.extras import _RANGES

    low, high = _RANGES.get(item.kind, (55.0, 1600.0))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    audio = torch.from_numpy(_mono(item, 16000)).unsqueeze(0)
    hop = 160  # 10 ms
    pitch, periodicity = torchcrepe.predict(
        audio,
        16000,
        hop,
        low,
        high,
        "full",
        return_periodicity=True,
        batch_size=512,
        device=device,
    )
    hz = pitch[0].cpu().numpy()
    voiced = periodicity[0].cpu().numpy() >= 0.5
    return notes_from_f0(np.arange(hz.size) * hop / 16000, hz, voiced)


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
    "pyin": method_pyin,
    "swiftf0": method_swiftf0,
    "swiftf0-notes": method_swiftf0_notes,
    "crepe": method_crepe,
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


PITCH_TRACKERS = {"yin", "pyin", "swiftf0", "swiftf0-notes", "crepe"}  # not for drum stems


def cmd_score(args: argparse.Namespace) -> None:
    bench: Path = args.bench
    sets = [s for s in args.sets.split(",") if s]
    methods = [m for m in args.methods.split(",") if m]
    SLAKH_CONDITIONS[:] = [c for c in args.conditions.split(",") if c]
    rows = []
    for set_name in sets:
        ids = PACK.get(set_name) if args.pack_only else None
        items = [i for i in LOADERS[set_name](bench, ids) if args.match in i.id]
        items = items[: args.limit or None]
        for item in items:
            for name in methods:
                if name in PITCH_TRACKERS and item.kind in DRUM_KINDS:
                    continue
                started = time.time()
                estimate = METHODS[name](item, bench)
                if estimate is None:
                    continue
                condition = item.id.rsplit("/", 1)[-1] if set_name == "slakh" else "clean"
                row = {
                    "set": set_name,
                    "item": item.id,
                    "kind": item.kind,
                    "condition": condition,
                    "method": name,
                }
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
    print(
        "| Set | Stem | Condition | Method | Items | Onset P | Onset R | Onset F1 | +Offset F1 "
        "| Octave errors |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    keys = sorted({(r["set"], r["kind"], r["condition"]) for r in rows})
    for set_name, kind, condition in keys:
        for name in methods:
            group = [
                r
                for r in rows
                if (r["set"], r["kind"], r["condition"], r["method"])
                == (set_name, kind, condition, name)
            ]
            if not group:
                continue

            def mean(key: str, group: list[dict] = group) -> float:
                return float(np.mean([r[key] for r in group]))

            print(
                f"| {set_name} | {kind} | {condition} | {name} | {len(group)} | "
                f"{mean('onset_p'):.3f} | {mean('onset_r'):.3f} | {mean('onset_f'):.3f} | "
                f"{mean('offset_f'):.3f} | {sum(r['octave_errors'] for r in group)} |"
            )


def cmd_separate(args: argparse.Namespace) -> None:
    """Run the app's recipes on the Slakh mixes through its real CLI, a batch at a time with a
    pause between batches. Songs already separated (a complete manifest) are skipped."""
    import os
    import subprocess

    from openstems.pipeline.run import read_manifest

    songs = slakh_songs(args.bench)
    links = args.bench / "slakh-mixes"  # one name per song: the output folder is named after it
    links.mkdir(parents=True, exist_ok=True)
    out = args.bench / "runs" / "slakh"
    engine = Path(__file__).resolve().parents[1] / "engine"
    env = {**os.environ, "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4"}
    for recipe in [r for r in args.recipes.split(",") if r]:
        todo = []
        for song in songs:
            manifest = read_manifest(out / song.name / recipe)
            if manifest and manifest.get("complete"):
                continue
            link = links / f"{song.name}.flac"
            if not link.exists():
                os.link(song / "mix.flac", link)
            todo.append(link)
        todo = todo[: args.limit or None]
        print(f"{recipe}: {len(todo)} songs to separate", flush=True)
        for start in range(0, len(todo), args.batch):
            batch = todo[start : start + args.batch]
            command = ["uv", "run", "--no-sync", "openstems", "separate", *map(str, batch)]
            command += ["--recipe", recipe, "--out", str(out)]
            subprocess.run(command, cwd=engine, env=env, check=True)
            if start + args.batch < len(todo):
                time.sleep(args.pause)


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
    s.add_argument("--match", default="", help="only items whose id contains this")
    s.add_argument("--conditions", default="separated,oracle", help="Slakh: separated, oracle")
    sub.add_parser("pack", help="copy the pack's audio and write its instructions")
    sep = sub.add_parser("separate", help="run the app's recipes on the Slakh mixes")
    sep.add_argument("--recipes", default="full-song,drum-kit")
    sep.add_argument("--limit", type=int, default=0, help="songs per recipe (0: all)")
    sep.add_argument("--batch", type=int, default=5, help="songs per CLI run")
    sep.add_argument("--pause", type=float, default=20.0, help="seconds between batches")
    args = parser.parse_args()
    {"score": cmd_score, "pack": cmd_pack, "separate": cmd_separate}[args.command](args)


if __name__ == "__main__":
    main()
