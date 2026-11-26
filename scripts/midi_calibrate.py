"""Fit and check the confidence of the single-line transcriber (Phase 7, stage M3).

``openstems.audio.transcribe`` gives every note it finds, sure or not, a confidence: a small
logistic model over what the note cost the segmenter and how it sounds (``FEATURES`` there).
This script fits that model on the benchmark's clean stems and says how far it can be trusted.

    cd engine
    uv run --with mir_eval==0.8.2 --with mido==1.3.3 python ../scripts/midi_calibrate.py \
        --bench D:\\lew-stems\\bench [fit | report]

- ``fit``: per profile (voice: vocadito; line: GuitarSet's solos; bass: Slakh's own bass
  stems), fit on every other clip, pick the confidence at which showing a note gives the best
  F1, and print the ``weights`` and ``threshold`` to paste into ``PROFILES``. Then the same
  figures as ``report``, on the clips the fit never saw.
- ``report``: with the weights now in ``PROFILES``, on the held-out clips: precision, recall
  and F1 of what is shown; how well confidence ranks right notes above wrong ones (AUC);
  whether a confidence of 0.8 means 80 percent right (the reliability table); and how many of
  the wrong shown notes fall in the unsure band, which is what an editor's "check these
  notes" needs.

A note counts as right when mir_eval pairs it with a reference note: onset within 50 ms and
pitch within 50 cents. Each clip's 16 kHz audio and the engine's pitch frames for it are
kept under ``<bench>/cache/f0``, so a second run takes seconds per set. Delete that folder
after changing how frames are made (the level a stem is read at, a profile's range, the
double-speed pass).
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


_pitch_frames = T.pitch_frames


def _frames(audio16: np.ndarray, profile: T.Profile) -> T.Frames:
    """`transcribe.pitch_frames`, its answer kept beside the clip's audio per profile."""
    path = _now["path"].with_suffix(f".{profile.name}.npz")
    if path.is_file():
        with np.load(path) as z:
            return T.Frames(z["m"], z["w"], z["level"])
    frames = _pitch_frames(audio16, profile)
    np.savez(path, m=frames.m, w=frames.w, level=frames.level)
    return frames


def transcribe(item: mb.Item, profile: str, bench: Path) -> T.Transcription:
    folder, stem = SETS[profile]
    audio, _now["path"] = _audio(item, bench / "cache" / "f0" / folder)
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


def collect(profile: str, bench: Path, limit: int | None) -> list[dict]:
    """Per clip: features, confidences as the engine has them now, and which notes are right."""
    rows = []
    for item in clips(profile, bench, limit):
        t = transcribe(item, profile, bench)
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
        rows = collect(profile, args.bench, args.limit or None)
        dev, held = rows[0::2], rows[1::2]
        if args.command == "fit":
            x = np.vstack([r["x"] for r in dev])
            y = np.concatenate([r["right"] for r in dev])
            w = fit(x, y.astype(float))
            dev_conf = [predict(w, r["x"]) for r in dev]
            grid = np.arange(0.10, 0.91, 0.01)
            threshold = float(grid[int(np.argmax([f1_at(dev, dev_conf, t)[2] for t in grid]))])
            share = float(y.mean())
            print(f"\n{profile}: fitted on {len(dev)} clips, {len(y)} notes ({share:.1%} right)")
            print(
                "  "
                + "  ".join(
                    f"{name} {v:+.3f}" for name, v in zip(("bias", *T.FEATURES), w, strict=True)
                )
            )
            print(f"  weights=({', '.join(f'{v:.4f}' for v in w)}),\n  threshold={threshold:.2f},")
            report(profile, held, [predict(w, r["x"]) for r in held], threshold)
        else:
            report(profile, held, [r["conf"] for r in held], T.PROFILES[profile].threshold)


if __name__ == "__main__":
    main()
