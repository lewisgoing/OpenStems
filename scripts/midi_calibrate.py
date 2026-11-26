"""Fit and check the confidence of the single-line transcriber (Phase 7, stage M3).

``openstems.audio.transcribe`` gives every note it finds, sure or not, a confidence: a small
logistic model over what the note cost the segmenter and how it sounds (``FEATURES`` there).
This script fits that model on the benchmark's stems and says how far it can be trusted.

A separated stem is not a clean one: a little of the rest of the song is left in it. Until
separated stems can be scored, that is stood in for here. Every clip is read three times:
alone, and with the rest of a song 25 dB and 15 dB under it (``BLEED``, RMS against the
stem's). For a bass the rest is its own song's other stems; a voice and a guitar solo, which
come alone, get a Slakh song's whole mix. The model is fitted on all three readings. Fitted
on clean stems alone it took a quiet note between a bass's own for a note, which with bleed
it is not.

    cd engine
    uv run --with mir_eval==0.8.2 --with mido==1.3.3 python ../scripts/midi_calibrate.py \
        --bench D:\\lew-stems\\bench [fit | report]

- ``fit``: per profile (voice: vocadito; line: GuitarSet's solos; bass: Slakh's own bass
  stems), fit on every other clip, in all three readings, pick the confidence at which
  showing a note gives the best F1 over them, and print the ``weights`` and ``threshold`` to
  paste into ``PROFILES``. Then the same figures as ``report``, on the clips the fit never
  saw.
- ``report``: with the weights now in ``PROFILES``, on the held-out clips read alone:
  precision, recall and F1 of what is shown; how well confidence ranks right notes above
  wrong ones (AUC); whether a confidence of 0.8 means 80 percent right (the reliability
  table); and how many of the wrong shown notes fall in the unsure band, which is what an
  editor's "check these notes" needs. Then precision, recall and F1 with bleed.

A note counts as right when mir_eval pairs it with a reference note: onset within 50 ms and
pitch within 50 cents. Each clip's 16 kHz audio and the engine's pitch frames for it are
kept under ``<bench>/cache/f0``, per reading, so a second run takes seconds per set. Delete
that folder after changing how frames are made (the level a stem is read at, a profile's
range, the double-speed pass).
"""

from __future__ import annotations

import argparse
import itertools
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import midi_bench as mb

from openstems.audio import transcribe as T

# profile: (cache folder, the stem name that picks the profile)
SETS = {"voice": ("vocadito", "vocals"), "line": ("guitar", "guitar"), "bass": ("bass", "bass")}
# How each clip is read: alone (None), and with the rest of a song this many dB under it.
BLEED: tuple[int | None, ...] = (None, 25, 15)
SLAKH_STEMS = ("bass", "drums", "guitar", "other", "piano")
_now: dict = {}


def clips(profile: str, bench: Path, limit: int | None = None) -> list[mb.Item]:
    if profile == "voice":
        out = mb.load_vocadito(bench, None)
    elif profile == "line":
        out = [i for i in mb.load_guitarset(bench, None) if i.id.endswith("_solo")]
    else:
        mb.SLAKH_CONDITIONS[:] = ["oracle"]
        mb.SLAKH_KINDS.clear()
        mb.SLAKH_KINDS.add("bass")
        out = mb.load_slakh(bench, None)
    return out[: limit or None]


def _audio(item: mb.Item, folder: Path) -> tuple[np.ndarray, Path]:
    """The clip as 16 kHz mono, read once and kept."""
    import soundfile as sf
    import soxr

    path = folder / (item.id.replace("/", "_") + ".npz")
    if path.is_file():
        with np.load(path) as z:
            return z["audio"], path
    data, rate = sf.read(str(item.audio), dtype="float32", always_2d=True)
    audio = soxr.resample(data.mean(axis=1), rate, T.RATE).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, audio=audio)
    return audio, path


def _mix16(folder: Path, names: tuple[str, ...], kept: Path) -> np.ndarray:
    """The sum of a Slakh song's stems named, as 16 kHz mono, read once and kept."""
    import soundfile as sf

    if kept.is_file():
        with np.load(kept) as z:
            return z["audio"]
    total: np.ndarray | None = None
    rate = T.RATE
    for name in names:
        path = folder / f"{name}.wav"
        if not path.is_file():
            continue
        data, rate = sf.read(str(path), dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        if total is None:
            total = mono
        else:
            n = min(len(total), len(mono))
            total = total[:n] + mono[:n]
    audio = T.mono16(total if total is not None else np.zeros(1, dtype=np.float32), rate)
    kept.parent.mkdir(parents=True, exist_ok=True)
    np.savez(kept, audio=audio)
    return audio


def _rest(item: mb.Item, profile: str, bench: Path, samples: int) -> np.ndarray:
    """What bleeds into a clip, as 16 kHz mono of its length. For a bass, its own song's
    other stems, in time with it. A voice and a guitar solo come alone, so each gets a
    Slakh song's whole mix, the same song every time, from 20 seconds in and round again."""
    import zlib

    cache = bench / "cache" / "f0"
    if profile == "bass":
        folder = Path(item.audio).parent
        others = tuple(n for n in SLAKH_STEMS if n != "bass")
        rest = _mix16(folder, others, cache / "bass" / (item.id.replace("/", "_") + ".rest.npz"))
    else:
        songs = sorted(p for p in (bench / "slakh-oracle").iterdir() if p.is_dir())
        folder = songs[zlib.crc32(item.id.encode()) % len(songs)]
        rest = _mix16(folder, SLAKH_STEMS, cache / "bank" / f"{folder.name}.npz")
        rest = np.roll(rest, -20 * T.RATE) if len(rest) > 40 * T.RATE else rest
    if len(rest) < samples:
        rest = np.tile(rest, samples // max(len(rest), 1) + 1)
    return rest[:samples]


_pitch_frames = T.pitch_frames


def _frames(audio16: np.ndarray, profile: T.Profile) -> T.Frames:
    """`transcribe.pitch_frames`, its answer kept beside the clip's audio per profile and
    per reading."""
    path = _now["path"].with_suffix(f".{profile.name}{_now['tag']}.npz")
    if path.is_file():
        with np.load(path) as z:
            return T.Frames(z["m"], z["w"], z["level"])
    frames = _pitch_frames(audio16, profile)
    np.savez(path, m=frames.m, w=frames.w, level=frames.level)
    return frames


def transcribe(
    item: mb.Item, profile: str, bench: Path, bleed: int | None = None
) -> T.Transcription:
    """The clip through the engine's transcriber: alone, or with the rest of a song
    ``bleed`` dB under it (RMS against the clip's)."""
    folder, stem = SETS[profile]
    audio, _now["path"] = _audio(item, bench / "cache" / "f0" / folder)
    _now["tag"] = "" if bleed is None else f".b{bleed}"
    if bleed is not None:
        rest = _rest(item, profile, bench, len(audio))
        level = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
        under = float(np.sqrt(np.mean(np.square(rest, dtype=np.float64))))
        audio = audio + rest * np.float32(level / max(under, 1e-9) * 10 ** (-bleed / 20))
    T.pitch_frames = _frames  # type: ignore[assignment]
    return T.transcribe_line(audio, T.RATE, stem)


def right(reference: list, notes: tuple) -> np.ndarray:
    """Per note: does mir_eval pair it with a reference note?"""
    import mir_eval

    out = np.zeros(len(notes), dtype=bool)
    if not notes or not reference:
        return out
    ref_i, ref_p = mb._arrays(reference)
    est_i, est_p = mb._arrays([(n.start, n.end, n.pitch, 0) for n in notes])
    for _, e in mir_eval.transcription.match_notes(ref_i, ref_p, est_i, est_p, offset_ratio=None):
        out[e] = True
    return out


def collect(profile: str, bench: Path, limit: int | None, bleed: int | None = None) -> list[dict]:
    """Per clip: features, confidences as the engine has them now, and which notes are right."""
    rows = []
    for item in clips(profile, bench, limit):
        t = transcribe(item, profile, bench, bleed)
        rows.append(
            {
                "id": item.id,
                "x": np.array(t.features, dtype=float).reshape(len(t.notes), len(T.FEATURES)),
                "conf": np.array([n.confidence for n in t.notes], dtype=float),
                "right": right(item.reference, t.notes),
                "refs": len(item.reference),
            }
        )
    return rows


def fit(x: np.ndarray, y: np.ndarray, l2: float = 1.0) -> np.ndarray:
    """Logistic regression by Newton's method, a small ridge on everything but the bias."""
    a = np.hstack([np.ones((len(x), 1)), x])
    w = np.zeros(a.shape[1])
    ridge = l2 * np.eye(a.shape[1])
    ridge[0, 0] = 0.0
    for _ in range(60):
        p = 1.0 / (1.0 + np.exp(-np.clip(a @ w, -30, 30)))
        step = np.linalg.solve(
            a.T @ (a * (p * (1 - p))[:, None]) + ridge, a.T @ (p - y) + ridge @ w
        )
        w -= step
        if float(np.abs(step).max()) < 1e-8:
            break
    return w


def predict(w: np.ndarray, x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(w[0] + x @ w[1:], -30, 30)))


def f1_at(
    rows: list[dict], confs: list[np.ndarray], threshold: float
) -> tuple[float, float, float]:
    """Mean per-clip precision, recall and F1 of the notes at or above a confidence."""
    out = []
    for row, conf in zip(rows, confs, strict=True):
        shown = conf >= threshold
        tp = int((row["right"] & shown).sum())
        p = tp / max(int(shown.sum()), 1)
        r = tp / max(row["refs"], 1)
        out.append((p, r, 2 * p * r / (p + r) if p + r else 0.0))
    p, r, f = np.mean(out, axis=0)
    return float(p), float(r), float(f)


def auc(conf: np.ndarray, y: np.ndarray) -> float:
    order = np.argsort(conf, kind="stable")
    ranks = np.empty(len(conf))
    ranks[order] = np.arange(1, len(conf) + 1)
    pos = int(y.sum())
    neg = len(y) - pos
    return (
        float((ranks[y].sum() - pos * (pos + 1) / 2) / (pos * neg)) if pos and neg else float("nan")
    )


def report(profile: str, rows: list[dict], confs: list[np.ndarray], threshold: float) -> None:
    conf = np.concatenate(confs)
    y = np.concatenate([r["right"] for r in rows])
    candidate = np.concatenate([r["x"][:, T.CANDIDATE] > 0 for r in rows])
    p, r, f = f1_at(rows, confs, threshold)
    # what the default pass alone gives: every note that is not a candidate
    own = [np.where(row["x"][:, T.CANDIDATE] > 0, 0.0, 1.0) for row in rows]
    base = f1_at(rows, own, 0.5)
    brier = float(np.mean((conf - y) ** 2))
    found = f"{len(y)} notes found, {int(candidate.sum())} of them candidates"
    print(f"\n{profile}: {len(rows)} held-out clips, {found}")
    print(f"  shown at confidence >= {threshold:.2f}:  P {p:.3f}  R {r:.3f}  F1 {f:.3f}")
    print(f"  the segmenter's own choice:      P {base[0]:.3f}  R {base[1]:.3f}  F1 {base[2]:.3f}")
    print(f"  ranks right above wrong (AUC): {auc(conf, y):.3f}   Brier score: {brier:.3f}")
    steps = [(t, *f1_at(rows, confs, t)) for t in (0.2, 0.35, 0.5, 0.65, 0.8, 0.9)]
    print("  sensitivity: " + "   ".join(f"{t:.2f}: P {a:.2f} R {b:.2f}" for t, a, b, _ in steps))
    print("  reliability (confidence said / notes / share right / mean said):")
    for lo, hi in itertools.pairwise(np.linspace(0, 1, 11)):
        sel = (conf >= lo) & (conf < hi + (hi == 1.0))
        if sel.sum():
            said, was = float(conf[sel].mean()), float(y[sel].mean())
            print(f"    {lo:.1f}-{hi:.1f}  {int(sel.sum()):6}  {was:.3f}  {said:.3f}")
    shown = conf >= threshold
    wrong = shown & ~y
    for band in (0.8, 0.9):
        unsure = shown & (conf < band)
        if wrong.sum() and unsure.sum():
            print(
                f"  check list (shown, under {band:.1f}): {int(unsure.sum())} notes, "
                f"{unsure.sum() / shown.sum():.1%} of what is shown; it holds "
                f"{(wrong & unsure).sum() / wrong.sum():.1%} of the wrong notes, and "
                f"{float((~y[unsure]).mean()):.1%} of it is wrong"
            )


def under_bleed(bleed: int, rows: list[dict], confs: list[np.ndarray], threshold: float) -> None:
    """One line: what is shown, and the first pass's own notes, with bleed."""
    p, r, f = f1_at(rows, confs, threshold)
    own = [np.where(row["x"][:, T.CANDIDATE] > 0, 0.0, 1.0) for row in rows]
    base = f1_at(rows, own, 0.5)
    print(
        f"  with the rest of a song {bleed} dB under it:  P {p:.3f}  R {r:.3f}  F1 {f:.3f}"
        f"   (the segmenter's own choice: P {base[0]:.3f}  R {base[1]:.3f}  F1 {base[2]:.3f})"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("command", choices=("fit", "report"), nargs="?", default="report")
    parser.add_argument("--bench", type=Path, default=Path(r"D:\lew-stems\bench"))
    parser.add_argument("--profiles", default="voice,line,bass")
    parser.add_argument("--limit", type=int, default=0, help="clips per profile (0: all)")
    args = parser.parse_args()
    for profile in [p for p in args.profiles.split(",") if p]:
        read = {b: collect(profile, args.bench, args.limit or None, b) for b in BLEED}
        held = {b: rows[1::2] for b, rows in read.items()}
        if args.command == "fit":
            dev = [row for rows in read.values() for row in rows[0::2]]  # every reading
            x = np.vstack([r["x"] for r in dev])
            y = np.concatenate([r["right"] for r in dev])
            w = fit(x, y.astype(float))
            dev_conf = [predict(w, r["x"]) for r in dev]
            grid = np.arange(0.10, 0.91, 0.01)
            threshold = float(grid[int(np.argmax([f1_at(dev, dev_conf, t)[2] for t in grid]))])
            share = float(y.mean())
            clips_n = len(read[None][0::2])
            print(
                f"\n{profile}: fitted on {clips_n} clips, each alone and with bleed, "
                f"{len(y)} notes ({share:.1%} right)"
            )
            print(
                "  "
                + "  ".join(
                    f"{name} {v:+.3f}" for name, v in zip(("bias", *T.FEATURES), w, strict=True)
                )
            )
            print(f"  weights=({', '.join(f'{v:.4f}' for v in w)}),\n  threshold={threshold:.2f},")
            report(profile, held[None], [predict(w, r["x"]) for r in held[None]], threshold)
            for b in BLEED[1:]:
                assert b is not None
                under_bleed(b, held[b], [predict(w, r["x"]) for r in held[b]], threshold)
        else:
            threshold = T.PROFILES[profile].threshold
            report(profile, held[None], [r["conf"] for r in held[None]], threshold)
            for b in BLEED[1:]:
                assert b is not None
                under_bleed(b, held[b], [r["conf"] for r in held[b]], threshold)


if __name__ == "__main__":
    main()
